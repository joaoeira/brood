/**
 * The only module that talks to Pi. Opens one session per agent pinned to its
 * controller scope, bridges session.prompt() into Effect with interruption
 * cleanup, classifies run settlement from live session events, and turns
 * control-tool markers into typed suspension via shouldStopAfterTurn.
 */
import { appendFile, chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createCodingTools,
  createAgentSession,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ToolDefinition,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Data, Effect, Queue, Ref, Result, Schema, Scope, Stream } from "effect";
import {
  AgentId,
  DelegateToolDetails,
  PiOpenError,
  PiProtocolError,
  PiRunError,
  WaitToolDetails,
} from "./agent.js";
import { AskAgentToolDetails } from "./communication.js";
import type { PiRunOutcome, SuspensionMarker } from "./control.js";
import type { ResolvedModelProfile } from "./profiles.js";

export interface PiSessionEvent {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly type:
    | "AgentStart"
    | "AgentSettled"
    | "TurnStart"
    | "TurnEnd"
    | "ToolStart"
    | "ToolEnd"
    | "RetryStart"
    | "RetryEnd"
    | "CompactionStart"
    | "CompactionEnd";
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface PiAgent {
  readonly sessionId: string;
  readonly events: Stream.Stream<PiSessionEvent>;
  readonly run: (prompt: string) => Effect.Effect<PiRunOutcome, PiRunError | PiProtocolError>;
  /**
   * Queue a Brood-rendered message for injection at the live run's next turn
   * boundary. Returns false — without queueing — when no run is in flight or
   * the current run has already committed to stopping; the caller falls back
   * to command-boundary delivery. Injection is confirmed through the settled
   * run's `deliveredOperatorMessages`, never assumed.
   */
  readonly steer: (renderedMessage: string) => boolean;
}

export interface PiOpenRequest {
  readonly agentId: AgentId;
  readonly profile: ResolvedModelProfile;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly systemPrompt: string;
}

export interface PiAdapter {
  readonly open: (request: PiOpenRequest) => Effect.Effect<PiAgent, PiOpenError, Scope.Scope>;
}

export interface PiAdapterOptions {
  readonly workspacePath: string;
  readonly piAgentDirectory: string;
  readonly sessionDirectory: string;
  readonly modelRuntime: ModelRuntime;
  readonly sessionCleanupTimeoutMillis: number;
  readonly eventBufferCapacity?: number;
}

export const DEFAULT_EVENT_BUFFER_CAPACITY = 256;

export class ConcurrentPiRunDefect extends Error {
  readonly _tag = "ConcurrentPiRunDefect";

  constructor(readonly agentId: AgentId) {
    super(`Concurrent Pi runs for ${agentId}`);
  }
}

export type ControlInspection = Data.TaggedEnum<{
  Continue: Record<never, never>;
  Suspend: {
    readonly markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>];
  };
  Malformed: { readonly error: PiProtocolError };
}>;

const ControlInspection = Data.taggedEnum<ControlInspection>();

export const inspectControlToolResults = (
  agentId: AgentId,
  toolResults: ReadonlyArray<ToolResultMessage>,
): ControlInspection => {
  const markers: Array<SuspensionMarker> = [];
  const malformed = (message: string): ControlInspection =>
    ControlInspection.Malformed({
      error: new PiProtocolError({
        agentId,
        message,
      }),
    });
  for (const result of toolResults) {
    if (
      result.toolName !== "delegate" &&
      result.toolName !== "wait_for_agents" &&
      result.toolName !== "ask_agent"
    ) {
      continue;
    }
    if (result.isError) continue;

    if (result.toolName === "delegate") {
      const decoded = Schema.decodeUnknownResult(DelegateToolDetails, {
        onExcessProperty: "error",
      })(result.details);
      if (Result.isFailure(decoded)) {
        return malformed(
          `Malformed ${result.toolName} control details: ${String(decoded.failure)}`,
        );
      }
      const control = decoded.success.broodControl;
      if (control.invocationId !== result.toolCallId) {
        return malformed(
          `${result.toolName} invocation ${control.invocationId} does not match tool call ${result.toolCallId}`,
        );
      }
      if (control.kind === "suspend") {
        markers.push({
          _tag: "AgentWait",
          tool: "delegate",
          invocationId: control.invocationId,
        });
      }
      continue;
    }

    if (result.toolName === "wait_for_agents") {
      const decoded = Schema.decodeUnknownResult(WaitToolDetails, {
        onExcessProperty: "error",
      })(result.details);
      if (Result.isFailure(decoded)) {
        return malformed(
          `Malformed ${result.toolName} control details: ${String(decoded.failure)}`,
        );
      }
      const control = decoded.success.broodControl;
      if (control.invocationId !== result.toolCallId) {
        return malformed(
          `${result.toolName} invocation ${control.invocationId} does not match tool call ${result.toolCallId}`,
        );
      }
      if (control.kind === "suspend") {
        markers.push({
          _tag: "AgentWait",
          tool: "wait_for_agents",
          invocationId: control.invocationId,
        });
      }
      continue;
    }

    const decoded = Schema.decodeUnknownResult(AskAgentToolDetails, {
      onExcessProperty: "error",
    })(result.details);
    if (Result.isFailure(decoded)) {
      return malformed(`Malformed ${result.toolName} control details: ${String(decoded.failure)}`);
    }
    const { broodControl: control, request } = decoded.success;
    if (control.invocationId !== result.toolCallId) {
      return malformed(
        `${result.toolName} invocation ${control.invocationId} does not match tool call ${result.toolCallId}`,
      );
    }
    if (control.kind !== "suspend") {
      return malformed("Successful ask_agent control details must suspend the caller");
    }
    markers.push({
      _tag: "RequestWait",
      tool: "ask_agent",
      invocationId: control.invocationId,
      request,
    });
  }
  const [first, ...rest] = markers;
  return first === undefined
    ? ControlInspection.Continue()
    : ControlInspection.Suspend({ markers: [first, ...rest] });
};

type Suspension = Data.TaggedEnum<{
  None: Record<never, never>;
  Marked: {
    readonly turn: AssistantMessage;
    readonly markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>];
  };
  Continued: Record<never, never>;
}>;

const Suspension = Data.taggedEnum<Suspension>();

interface RunClassifier {
  finalTurn: AssistantMessage | undefined;
  protocolError: PiProtocolError | undefined;
  suspension: Suspension;
  /** True once shouldStopAfterTurn committed to ending this run; steers are refused after. */
  stopDecided: boolean;
  /** Operator-message ids observed as injected user messages during this run. */
  deliveredOperatorMessages: Array<string>;
}

const freshClassifier = (): RunClassifier => ({
  finalTurn: undefined,
  protocolError: undefined,
  suspension: Suspension.None(),
  stopDecided: false,
  deliveredOperatorMessages: [],
});

const OPERATOR_MESSAGE_ID_PATTERN = /^<brood_operator_message id="(opmsg_[A-Za-z0-9-]+)"/;

const userMessageText = (content: string | ReadonlyArray<{ type: string }>): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .join("\n");

const safeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant";

const setFirstProtocolError = (state: RunClassifier, error: PiProtocolError): void => {
  state.protocolError ??= error;
};

const validateToolBatch = (
  agentId: AgentId,
  message: AssistantMessage,
  results: ReadonlyArray<ToolResultMessage>,
): PiProtocolError | undefined => {
  const calls = message.content.filter((entry) => entry.type === "toolCall");
  if (calls.length !== results.length) {
    return new PiProtocolError({
      agentId,
      message: `Incomplete tool batch: ${calls.length} calls but ${results.length} results`,
    });
  }
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const result = results[index];
    if (call === undefined || result === undefined) continue;
    if (call.id !== result.toolCallId || call.name !== result.toolName) {
      return new PiProtocolError({
        agentId,
        message: `Tool result ${index} does not match its assistant tool call`,
      });
    }
  }
  return undefined;
};

const assertNeverStopReason = (reason: never): never => {
  throw new Error(`Unhandled Pi stop reason: ${String(reason)}`);
};

const classifySettledRun = (
  agentId: AgentId,
  state: RunClassifier,
): Effect.Effect<PiRunOutcome, PiRunError | PiProtocolError> => {
  if (state.protocolError !== undefined) return Effect.fail(state.protocolError);
  if (state.suspension._tag === "Continued") {
    return Effect.fail(
      new PiProtocolError({ agentId, message: "Pi continued or queued input after suspension" }),
    );
  }
  const turn = state.finalTurn;
  if (turn === undefined) {
    return Effect.fail(
      new PiRunError({ agentId, message: "Pi prompt settled without an assistant turn" }),
    );
  }
  if (state.suspension._tag === "Marked") {
    if (turn !== state.suspension.turn) {
      return Effect.fail(
        new PiProtocolError({
          agentId,
          message: "Pi settled on a different assistant turn after a suspension marker",
        }),
      );
    }
    if (state.suspension.turn.stopReason !== "toolUse") {
      return Effect.fail(
        new PiProtocolError({ agentId, message: "Suspension marker was not on a toolUse turn" }),
      );
    }
    return Effect.succeed({
      _tag: "Suspended",
      markers: state.suspension.markers,
      deliveredOperatorMessages: state.deliveredOperatorMessages,
    });
  }

  const stopReason: StopReason = turn.stopReason;
  switch (stopReason) {
    case "stop":
      if (turn.content.some((entry) => entry.type === "toolCall")) {
        return Effect.fail(
          new PiProtocolError({
            agentId,
            message: "Final stop turn contained unresolved tool calls",
          }),
        );
      }
      return Effect.succeed({
        _tag: "Completed",
        result: {
          finalText: contentText(turn.content),
          finalMessageId: turn.responseId,
          stopReason: "stop",
        },
        deliveredOperatorMessages: state.deliveredOperatorMessages,
      });
    case "pending":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
    case "deferred":
      return Effect.fail(
        new PiRunError({
          agentId,
          message: turn.errorMessage ?? `Pi ended with stop reason ${stopReason}`,
          stopReason,
        }),
      );
    default:
      return assertNeverStopReason(stopReason);
  }
};

type PiSessionEventKind = Omit<PiSessionEvent, "agentId" | "sessionId" | "sessionSequence">;

const toMonitorEventKind = (event: AgentSessionEvent): PiSessionEventKind | undefined => {
  switch (event.type) {
    case "agent_start":
      return { type: "AgentStart" };
    case "agent_settled":
      return { type: "AgentSettled" };
    case "turn_start":
      return { type: "TurnStart" };
    case "turn_end":
      return { type: "TurnEnd" };
    case "tool_execution_start":
      return {
        type: "ToolStart",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        type: "ToolEnd",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "auto_retry_start":
      return { type: "RetryStart" };
    case "auto_retry_end":
      return { type: "RetryEnd" };
    case "compaction_start":
      return { type: "CompactionStart" };
    case "compaction_end":
      return { type: "CompactionEnd" };
    default:
      return undefined;
  }
};

const piOpenError = (agentId: AgentId, cause: unknown): PiOpenError =>
  new PiOpenError({ agentId, message: safeMessage(cause) });

const secureDirectory = (path: string, agentId: AgentId): Effect.Effect<void, PiOpenError> =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true, mode: 0o700 }).then(() => chmod(path, 0o700)),
    catch: (cause) => piOpenError(agentId, cause),
  }).pipe(Effect.asVoid);

// ── Session resume ──────────────────────────────────────────────────────────
//
// A revived agent reopens the conversation it already had: the newest .jsonl
// in its per-agent session directory, selected by mtime exactly like Pi's own
// findMostRecentSession. A file may not exist at all when the agent never
// produced an assistant reply — Pi defers the first write until then — in
// which case the agent starts a fresh session and the registry re-issues its
// goal.

export const findLatestSessionFile = async (directory: string): Promise<string | undefined> => {
  const names = await readdir(directory);
  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(directory, name);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
      }),
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path;
};

/**
 * Repair a session interrupted mid-tool-batch before reopening it. An abort
 * between tool executions persists the assistant's toolCall blocks but never
 * writes results for the calls the loop had not reached; Pi has no repair
 * path of its own and would replay the malformed transcript verbatim, which
 * providers reject ("tool_use without tool_result"). Synthetic aborted
 * results are appended in call order, chained onto the entry tree exactly as
 * Pi would append them. Returns how many results were synthesized.
 */
export const repairDanglingToolCalls = async (sessionFile: string): Promise<number> => {
  const raw = await readFile(sessionFile, "utf8");
  const entries: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        entries.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Matches Pi's own reader: malformed lines are skipped, not fatal.
    }
  }

  const calls = new Map<string, string>();
  const answered = new Set<string>();
  const usedIds = new Set<string>();
  let leafId: string | null = null;
  for (const entry of entries) {
    if (typeof entry.id === "string") usedIds.add(entry.id);
    if (entry.type !== "session" && typeof entry.id === "string") leafId = entry.id;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (typeof message !== "object" || message === null) continue;
    const { role, content, toolCallId } = message as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
    };
    if (role === "assistant" && Array.isArray(content)) {
      for (const block of content as ReadonlyArray<Record<string, unknown>>) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          calls.set(block.id, typeof block.name === "string" ? block.name : "unknown");
        }
      }
    } else if (role === "toolResult" && typeof toolCallId === "string") {
      answered.add(toolCallId);
    }
  }

  const dangling = Array.from(calls).filter(([callId]) => !answered.has(callId));
  if (dangling.length === 0) return 0;

  const freshEntryId = (): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = randomUUID().slice(0, 8);
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
    return randomUUID();
  };

  const lines = dangling.map(([toolCallId, toolName]) => {
    const id = freshEntryId();
    const entry = {
      type: "message",
      id,
      parentId: leafId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [
          {
            type: "text",
            text: "Operation aborted: this tool call was interrupted before it could run and produced no result.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      },
    };
    leafId = id;
    return `${JSON.stringify(entry)}\n`;
  });
  await appendFile(sessionFile, lines.join(""));
  return dangling.length;
};

export const makePiAdapter = (options: PiAdapterOptions): PiAdapter => ({
  open: Effect.fn("Brood.PiAdapter.open")(function* (request) {
    const builtInToolNames = createCodingTools(options.workspacePath).map(({ name }) => name);
    const expectedTools = [...builtInToolNames, ...request.tools.map(({ name }) => name)];
    const seenToolNames = new Set<string>();
    for (const name of expectedTools) {
      if (seenToolNames.has(name)) {
        return yield* Effect.fail(
          new PiOpenError({
            agentId: request.agentId,
            message: `Duplicate Pi tool name: ${name}. Every built-in and custom tool name must be unique.`,
          }),
        );
      }
      seenToolNames.add(name);
    }

    const agentSessionDirectory = join(options.sessionDirectory, request.agentId);
    yield* Effect.forEach(
      [options.piAgentDirectory, agentSessionDirectory],
      (path) => secureDirectory(path, request.agentId),
      { discard: true },
    );

    const settingsManager = SettingsManager.create(
      options.workspacePath,
      options.piAgentDirectory,
      { projectTrusted: false },
    );
    // A first open finds no file and creates a fresh session; a revival finds
    // the agent's previous conversation and reopens it in place — repaired
    // first if an interrupt left tool calls without results.
    const existingSessionFile = yield* Effect.tryPromise({
      try: () => findLatestSessionFile(agentSessionDirectory),
      catch: (cause) => piOpenError(request.agentId, cause),
    });
    if (existingSessionFile !== undefined) {
      const repaired = yield* Effect.tryPromise({
        try: () => repairDanglingToolCalls(existingSessionFile),
        catch: (cause) => piOpenError(request.agentId, cause),
      });
      if (repaired > 0) {
        yield* Effect.logInfo("Repaired dangling tool calls before session resume").pipe(
          Effect.annotateLogs({ agentId: request.agentId, repaired }),
        );
      }
    }
    const sessionManager =
      existingSessionFile === undefined
        ? SessionManager.create(options.workspacePath, agentSessionDirectory)
        : SessionManager.open(existingSessionFile, agentSessionDirectory, options.workspacePath);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.workspacePath,
      agentDir: options.piAgentDirectory,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => request.systemPrompt,
    });
    yield* Effect.tryPromise({
      try: () => resourceLoader.reload(),
      catch: (cause) => piOpenError(request.agentId, cause),
    });

    const queue = yield* Queue.sliding<PiSessionEvent>(
      options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY,
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const inFlight = yield* Ref.make(false);
    let classifier = freshClassifier();
    let sessionSequence = 0;

    const acquired = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const created = yield* Effect.tryPromise({
          try: () =>
            createAgentSession({
              cwd: options.workspacePath,
              agentDir: options.piAgentDirectory,
              modelRuntime: options.modelRuntime,
              model: request.profile.model,
              thinkingLevel: request.profile.public.thinkingLevel,
              customTools: [...request.tools],
              resourceLoader,
              sessionManager,
              settingsManager,
            }),
          catch: (cause) => piOpenError(request.agentId, cause),
        });
        const session = created.session;
        const abortAndAwait = Effect.try({
          try: () => session.abortCompaction(),
          catch: (cause) => cause,
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => session.abort(),
              catch: (cause) => cause,
            }).pipe(Effect.timeout(options.sessionCleanupTimeoutMillis)),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Pi session cleanup did not finish cleanly").pipe(
              Effect.annotateLogs({
                agentId: request.agentId,
                sessionId: session.sessionId,
                cause: safeMessage(cause),
              }),
            ),
          ),
        );
        delete session.agent.prepareNextTurn;
        delete session.agent.prepareNextTurnWithContext;

        session.agent.shouldStopAfterTurn = ({ message, toolResults }) =>
          ControlInspection.$match(inspectControlToolResults(request.agentId, toolResults), {
            Continue: () => false,
            Suspend: ({ markers }) => {
              classifier.suspension = Suspension.Marked({ turn: message, markers });
              classifier.stopDecided = true;
              // The loop stops without draining steering, and AgentSession
              // would auto-continue a stopped run whose queue is nonempty —
              // which the classifier must reject. Undrained steers stay
              // pending in the registry, so clearing loses nothing.
              session.agent.clearSteeringQueue();
              return true;
            },
            Malformed: ({ error }) => {
              setFirstProtocolError(classifier, error);
              classifier.stopDecided = true;
              session.agent.clearSteeringQueue();
              return true;
            },
          });

        const unsubscribe = session.subscribe((event) => {
          try {
            switch (event.type) {
              case "message_end":
                // A steered operator message becomes a persisted user message;
                // its id attribute is the delivery confirmation finishTurn
                // consumes. Command-embedded blocks carry no id.
                if (event.message.role === "user") {
                  const match = OPERATOR_MESSAGE_ID_PATTERN.exec(
                    userMessageText(event.message.content),
                  );
                  const delivered = match?.[1];
                  if (delivered !== undefined) {
                    classifier.deliveredOperatorMessages.push(delivered);
                  }
                }
                break;
              case "turn_start":
                if (classifier.suspension._tag === "Marked") {
                  classifier.suspension = Suspension.Continued();
                }
                break;
              case "turn_end":
                if (!isAssistant(event.message)) {
                  setFirstProtocolError(
                    classifier,
                    new PiProtocolError({
                      agentId: request.agentId,
                      message: "Pi turn ended without an assistant message",
                    }),
                  );
                } else {
                  const error =
                    event.message.stopReason === "error" || event.message.stopReason === "aborted"
                      ? undefined
                      : validateToolBatch(request.agentId, event.message, event.toolResults);
                  if (error !== undefined) setFirstProtocolError(classifier, error);
                  classifier.finalTurn = event.message;
                }
                break;
            }
            const kind = toMonitorEventKind(event);
            if (kind !== undefined) {
              sessionSequence += 1;
              Queue.offerUnsafe(queue, {
                agentId: request.agentId,
                sessionId: session.sessionId,
                sessionSequence,
                ...kind,
              });
            }
          } catch {
            // Pi listeners are synchronous. Monitoring and defensive classification must never escape.
          }
        });
        return { created, session, abortAndAwait, unsubscribe };
      }),
      ({ abortAndAwait, session, unsubscribe }) =>
        abortAndAwait.pipe(
          Effect.andThen(Effect.sync(unsubscribe)),
          Effect.andThen(
            Effect.sync(() => {
              try {
                session.dispose();
              } catch {
                // Disposal is best effort after the awaited abort barrier.
              }
            }),
          ),
        ),
    );
    const { abortAndAwait, created, session } = acquired;

    const invariant = (condition: boolean, message: string): Effect.Effect<void> =>
      condition ? Effect.void : Effect.die(new Error(message));
    yield* invariant(
      created.modelFallbackMessage === undefined,
      `Explicit Pi model unexpectedly fell back for ${request.agentId}`,
    );
    yield* invariant(
      session.model?.provider === request.profile.model.provider &&
        session.model.id === request.profile.model.id &&
        session.thinkingLevel === request.profile.public.thinkingLevel,
      `Pi session profile mismatch for ${request.agentId}`,
    );
    const activeTools = session.getActiveToolNames();
    const sortedActiveTools = [...activeTools].sort();
    const sortedExpectedTools = [...expectedTools].sort();
    const toolsMatch =
      sortedActiveTools.length === sortedExpectedTools.length &&
      sortedActiveTools.every((value, index) => value === sortedExpectedTools[index]);
    yield* invariant(
      toolsMatch,
      `Unexpected active Pi tools for ${request.agentId}: ${activeTools.join(", ")}`,
    );
    yield* invariant(
      created.extensionsResult.extensions.length === 0,
      `Pi extensions loaded for ${request.agentId}`,
    );

    let runInFlight = false;
    const acquireRun = Ref.getAndSet(inFlight, true).pipe(
      Effect.flatMap((alreadyActive) =>
        alreadyActive ? Effect.die(new ConcurrentPiRunDefect(request.agentId)) : Effect.void,
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          runInFlight = true;
        }),
      ),
    );

    const run = Effect.fn("Brood.PiAgent.run")((prompt: string) =>
      Effect.acquireUseRelease(
        acquireRun,
        () => {
          const state = freshClassifier();
          classifier = state;
          return Effect.tryPromise({
            try: () =>
              session.prompt(prompt, {
                expandPromptTemplates: false,
                source: "extension",
              }),
            catch: (cause) =>
              new PiRunError({ agentId: request.agentId, message: safeMessage(cause) }),
          }).pipe(
            Effect.onInterrupt(() => abortAndAwait),
            Effect.andThen(Effect.suspend(() => classifySettledRun(request.agentId, state))),
          );
        },
        () =>
          Effect.sync(() => {
            runInFlight = false;
          }).pipe(Effect.andThen(Ref.set(inFlight, false))),
      ),
    );

    const steer = (renderedMessage: string): boolean => {
      // The event loop is single-threaded: stopDecided is set synchronously
      // inside the stop hook, so a steer observed here either lands before the
      // final drain or is refused — never silently dropped by the clear.
      if (!runInFlight || classifier.stopDecided) return false;
      session.agent.steer({
        role: "user",
        content: renderedMessage,
        timestamp: Date.now(),
      });
      return true;
    };

    return {
      sessionId: session.sessionId,
      events: Stream.fromQueue(queue),
      run,
      steer,
    } satisfies PiAgent;
  }),
});
