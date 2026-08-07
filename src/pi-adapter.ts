import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ToolDefinition,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Queue, Ref, Result, Schema, Scope, Stream } from "effect";
import {
  AgentId,
  PiOpenError,
  PiProtocolError,
  PiRunError,
  type PiRunOutcome,
  type ResolvedModelProfile,
} from "./agent.js";
import { DelegateToolDetails, WaitToolDetails } from "./tools.js";

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

export class ConcurrentPiRunDefect extends Error {
  readonly _tag = "ConcurrentPiRunDefect";

  constructor(readonly agentId: AgentId) {
    super(`Concurrent Pi runs for ${agentId}`);
  }
}

export interface ControlInspection {
  readonly suspend: boolean;
  readonly protocolError?: PiProtocolError;
}

export const inspectControlToolResults = (
  agentId: AgentId,
  toolResults: ReadonlyArray<ToolResultMessage>,
): ControlInspection => {
  try {
    let suspend = false;
    for (const result of toolResults) {
      if (result.toolName !== "delegate" && result.toolName !== "wait_for_agents") continue;
      if (result.isError) continue;
      const decodeFailure = (failure: unknown): ControlInspection => ({
        suspend: false,
        protocolError: new PiProtocolError({
          agentId,
          message: `Malformed ${result.toolName} control details: ${String(failure)}`,
        }),
      });
      let control;
      if (result.toolName === "delegate") {
        const decoded = Schema.decodeUnknownResult(DelegateToolDetails)(result.details);
        if (Result.isFailure(decoded)) return decodeFailure(decoded.failure);
        control = decoded.success.broodControl;
      } else {
        const decoded = Schema.decodeUnknownResult(WaitToolDetails)(result.details);
        if (Result.isFailure(decoded)) return decodeFailure(decoded.failure);
        control = decoded.success.broodControl;
      }
      if (control.invocationId !== result.toolCallId) {
        return {
          suspend: false,
          protocolError: new PiProtocolError({
            agentId,
            message: `${result.toolName} invocation ${control.invocationId} does not match tool call ${result.toolCallId}`,
          }),
        };
      }
      suspend = suspend || control.kind === "suspend";
    }
    return { suspend };
  } catch (cause) {
    return {
      suspend: false,
      protocolError: new PiProtocolError({
        agentId,
        message: `Control-result inspection defect: ${safeMessage(cause)}`,
      }),
    };
  }
};

interface FinalTurn {
  readonly message: AssistantMessage;
  readonly toolResults: ReadonlyArray<ToolResultMessage>;
}

interface RunClassifier {
  finalTurn: FinalTurn | undefined;
  protocolError: PiProtocolError | undefined;
  suspended: boolean;
  settled: boolean;
  unexpectedContinuation: boolean;
  queuedMessages: boolean;
  readonly pendingTools: Set<string>;
}

const freshClassifier = (): RunClassifier => ({
  finalTurn: undefined,
  protocolError: undefined,
  suspended: false,
  settled: false,
  unexpectedContinuation: false,
  queuedMessages: false,
  pendingTools: new Set(),
});

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
  pendingMessageCount: number,
): Effect.Effect<PiRunOutcome, PiRunError | PiProtocolError> => {
  if (state.protocolError !== undefined) return Effect.fail(state.protocolError);
  if (!state.settled) {
    return Effect.fail(
      new PiRunError({ agentId, message: "Pi prompt resolved before agent_settled" }),
    );
  }
  if (state.pendingTools.size > 0) {
    return Effect.fail(
      new PiRunError({ agentId, message: "Pi prompt settled with pending tool executions" }),
    );
  }
  if (state.unexpectedContinuation || state.queuedMessages || pendingMessageCount > 0) {
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
  if (state.suspended) {
    if (turn.message.stopReason !== "toolUse") {
      return Effect.fail(
        new PiProtocolError({ agentId, message: "Suspension marker was not on a toolUse turn" }),
      );
    }
    return Effect.succeed({ _tag: "Suspended" });
  }

  const stopReason: StopReason = turn.message.stopReason;
  switch (stopReason) {
    case "stop":
      if (turn.message.content.some((entry) => entry.type === "toolCall")) {
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
          finalText: contentText(turn.message.content),
          finalMessageId: turn.message.responseId,
          stopReason: "stop",
        },
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
          message: turn.message.errorMessage ?? `Pi ended with stop reason ${stopReason}`,
          stopReason,
        }),
      );
    default:
      return assertNeverStopReason(stopReason);
  }
};

const toMonitorEvent = (
  agentId: AgentId,
  sessionId: string,
  sessionSequence: number,
  event: AgentSessionEvent,
): PiSessionEvent | undefined => {
  const base = { agentId, sessionId, sessionSequence };
  switch (event.type) {
    case "agent_start":
      return { ...base, type: "AgentStart" };
    case "agent_settled":
      return { ...base, type: "AgentSettled" };
    case "turn_start":
      return { ...base, type: "TurnStart" };
    case "turn_end":
      return { ...base, type: "TurnEnd" };
    case "tool_execution_start":
      return {
        ...base,
        type: "ToolStart",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        ...base,
        type: "ToolEnd",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "auto_retry_start":
      return { ...base, type: "RetryStart" };
    case "auto_retry_end":
      return { ...base, type: "RetryEnd" };
    case "compaction_start":
      return { ...base, type: "CompactionStart" };
    case "compaction_end":
      return { ...base, type: "CompactionEnd" };
    default:
      return undefined;
  }
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

export const makePiAdapter = (options: PiAdapterOptions): PiAdapter => ({
  open: Effect.fn("Brood.PiAdapter.open")(function* (request) {
    const agentSessionDirectory = join(options.sessionDirectory, request.agentId);
    yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          mkdir(options.piAgentDirectory, { recursive: true }),
          mkdir(agentSessionDirectory, { recursive: true }),
        ]),
      catch: (cause) => new PiOpenError({ agentId: request.agentId, message: safeMessage(cause) }),
    });

    const settingsManager = SettingsManager.create(
      options.workspacePath,
      options.piAgentDirectory,
      { projectTrusted: false },
    );
    const sessionManager = SessionManager.create(options.workspacePath, agentSessionDirectory);
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
      catch: (cause) => new PiOpenError({ agentId: request.agentId, message: safeMessage(cause) }),
    });

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
      catch: (cause) => new PiOpenError({ agentId: request.agentId, message: safeMessage(cause) }),
    });
    const session = created.session;
    const queue = yield* Queue.sliding<PiSessionEvent>(options.eventBufferCapacity ?? 256);
    const inFlight = yield* Ref.make(false);
    let classifier = freshClassifier();
    let sessionSequence = 0;
    let unsubscribe = (): void => {};

    const abortAndAwait = Effect.sync(() => session.abortCompaction()).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => session.abort(),
          catch: (cause) => cause,
        }).pipe(Effect.timeout(options.sessionCleanupTimeoutMillis)),
      ),
      Effect.catchCause(() =>
        Effect.logWarning("Pi session cleanup did not finish cleanly", {
          agentId: request.agentId,
          sessionId: session.sessionId,
        }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      abortAndAwait.pipe(
        Effect.andThen(Effect.sync(() => unsubscribe())),
        Effect.andThen(
          Effect.sync(() => {
            try {
              session.dispose();
            } catch {
              // Disposal is best effort after the awaited abort barrier.
            }
          }),
        ),
        Effect.andThen(Queue.shutdown(queue)),
      ),
    );

    delete session.agent.prepareNextTurn;
    delete session.agent.prepareNextTurnWithContext;

    session.agent.shouldStopAfterTurn = ({ toolResults }) => {
      const inspection = inspectControlToolResults(request.agentId, toolResults);
      if (inspection.protocolError !== undefined) {
        setFirstProtocolError(classifier, inspection.protocolError);
        return true;
      }
      if (inspection.suspend) classifier.suspended = true;
      return inspection.suspend;
    };

    unsubscribe = session.subscribe((event) => {
      try {
        switch (event.type) {
          case "turn_start":
            if (classifier.suspended) classifier.unexpectedContinuation = true;
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
              const error = validateToolBatch(request.agentId, event.message, event.toolResults);
              if (error !== undefined) setFirstProtocolError(classifier, error);
              classifier.finalTurn = { message: event.message, toolResults: event.toolResults };
            }
            break;
          case "tool_execution_start":
            classifier.pendingTools.add(event.toolCallId);
            break;
          case "tool_execution_end":
            classifier.pendingTools.delete(event.toolCallId);
            break;
          case "agent_settled":
            classifier.settled = true;
            break;
          case "queue_update":
            if (event.steering.length > 0 || event.followUp.length > 0) {
              classifier.queuedMessages = true;
            }
            break;
        }
        const monitor = toMonitorEvent(
          request.agentId,
          session.sessionId,
          ++sessionSequence,
          event,
        );
        if (monitor !== undefined) Queue.offerUnsafe(queue, monitor);
      } catch {
        // Pi listeners are synchronous. Monitoring and defensive classification must never escape.
      }
    });

    if (created.modelFallbackMessage !== undefined) {
      return yield* Effect.die(
        new Error(`Explicit Pi model unexpectedly fell back for ${request.agentId}`),
      );
    }
    if (
      session.model?.provider !== request.profile.model.provider ||
      session.model.id !== request.profile.model.id ||
      session.thinkingLevel !== request.profile.public.thinkingLevel
    ) {
      return yield* Effect.die(new Error(`Pi session profile mismatch for ${request.agentId}`));
    }
    const expectedTools = ["read", "bash", "edit", "write", "delegate", "wait_for_agents"];
    if (!sameStrings(session.getActiveToolNames(), expectedTools)) {
      return yield* Effect.die(
        new Error(
          `Unexpected active Pi tools for ${request.agentId}: ${session.getActiveToolNames().join(", ")}`,
        ),
      );
    }
    if (created.extensionsResult.extensions.length > 0) {
      return yield* Effect.die(new Error(`Pi extensions loaded for ${request.agentId}`));
    }

    const acquireRun = Ref.modify(inFlight, (active) =>
      active ? ([true, true] as const) : ([false, true] as const),
    ).pipe(
      Effect.flatMap((alreadyActive) =>
        alreadyActive ? Effect.die(new ConcurrentPiRunDefect(request.agentId)) : Effect.void,
      ),
    );

    const run = Effect.fn("Brood.PiAgent.run")((prompt: string) =>
      Effect.acquireUseRelease(
        acquireRun,
        () => {
          classifier = freshClassifier();
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
            Effect.andThen(
              Effect.suspend(() =>
                classifySettledRun(request.agentId, classifier, session.pendingMessageCount),
              ),
            ),
          );
        },
        () => Ref.set(inFlight, false),
      ),
    );

    return {
      sessionId: session.sessionId,
      events: Stream.fromQueue(queue),
      run,
    } satisfies PiAgent;
  }),
});
