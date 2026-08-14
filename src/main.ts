/**
 * Programmatic entry point: composes runtime, supervisor, and Pi adapter into
 * a scoped BroodApplication, and interprets the root's value-level outcome
 * into BroodResult | AgentFailed | RootInterrupted after draining orphans.
 */
import { Duration, Effect, Latch, References, type PubSub, type Scope } from "effect";
import {
  AgentFailed,
  RootInterrupted,
  RootStartError,
  type AgentId,
  type AgentOutcome,
  type BroodResult,
  type BroodConfigError,
  type BroodRunRequest,
  type BroodRunRequestEncoded,
  type DrainReport,
  type UnknownAgentReference,
} from "./agent.js";
import {
  DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
  codePointLength,
  normalizeText,
  summarizeAgentFailure,
} from "./render.js";
import { makePiAdapter } from "./pi-adapter.js";
import {
  buildBroodRuntime,
  buildBroodRuntimeUnknown,
  type BroodConfigEncoded,
  type BroodRuntime,
  type PiAuthSource,
} from "./runtime.js";
import { makeSupervisor, type SupervisorEvent } from "./supervisor.js";
import type {
  BulletinView,
  OperatorMessageDelivery,
  OperatorMessageRejected,
  TrafficView,
} from "./registry.js";
import type { AgentDetail, SwarmStatus } from "./status.js";

export interface BroodController {
  readonly status: Effect.Effect<SwarmStatus>;
  readonly show: (reference: string) => Effect.Effect<AgentDetail, UnknownAgentReference>;
  readonly interrupt: (
    reference: string,
    source?: "cli" | "api",
  ) => Effect.Effect<AgentId, UnknownAgentReference>;
  readonly events: Effect.Effect<PubSub.Subscription<SupervisorEvent>, never, Scope.Scope>;
  /** Operator view of the retained bulletin board, in global sequence order. */
  readonly bulletins: Effect.Effect<ReadonlyArray<BulletinView>>;
  /** Operator-only communication log: bodies, read state, correlation. */
  readonly traffic: Effect.Effect<ReadonlyArray<TrafficView>>;
  /** Deliver a direct operator message; wakes a parked recipient — and
   * revives a finished one. */
  readonly sendOperatorMessage: (
    reference: string,
    body: string,
  ) => Effect.Effect<OperatorMessageDelivery, UnknownAgentReference | OperatorMessageRejected>;
  /** Session mode only: end the run. Revivals close, stragglers drain, and
   * `run` resolves with the root's latest delivered result. Idempotent; a
   * no-op for runs not started in session mode. */
  readonly close: Effect.Effect<void>;
}

/** The materialized locations a run will actually use, for operator display. */
export interface BroodResolvedPaths {
  readonly workspacePath: string;
  readonly stateDirectory: string;
  readonly piAgentDirectory: string;
  readonly sessionDirectory: string;
  readonly piAuth: PiAuthSource;
}

export interface BroodRunOptions {
  /**
   * Session mode: the run does not end when the root completes. The swarm
   * idles settled — every agent revivable by operator message, urgent mail,
   * or a peer question — until `controller.close` ends it. The default (off)
   * keeps the classic contract: root settles, stragglers drain, run returns.
   */
  readonly session?: boolean;
}

export interface BroodApplication {
  readonly controller: BroodController;
  readonly resolved: BroodResolvedPaths;
  readonly run: (
    request: BroodRunRequestEncoded,
    options?: BroodRunOptions,
  ) => Effect.Effect<BroodResult, AgentFailed | RootInterrupted | RootStartError>;
}

/** The only semantic gate for run input. Structural shape is Schema's job;
 * this owns trimming, normalization, and the instruction bound. Rejects rather
 * than truncates: instructions are operator policy, and executing a truncated
 * charter would be less honest than failing. */
export const normalizeRunRequest = Effect.fn("Brood.normalizeRunRequest")((
  input: BroodRunRequestEncoded,
  maxRunInstructionsChars: number,
): Effect.Effect<BroodRunRequest, RootStartError> => {
  const goal = normalizeText(input.goal).trim();
  if (goal === "") {
    return Effect.fail(
      new RootStartError({ reason: "InvalidGoal", message: "Goal must not be empty" }),
    );
  }
  if (input.instructions === undefined) return Effect.succeed({ goal });
  const instructions = normalizeText(input.instructions).trim();
  if (instructions === "") {
    return Effect.fail(
      new RootStartError({
        reason: "InvalidInstructions",
        message: "Explicitly supplied run instructions must not be empty",
      }),
    );
  }
  const length = codePointLength(instructions);
  if (length > maxRunInstructionsChars) {
    return Effect.fail(
      new RootStartError({
        reason: "InvalidInstructions",
        message: `Run instructions contain ${length} Unicode code points; the maximum is ${maxRunInstructionsChars}`,
      }),
    );
  }
  return Effect.succeed({ goal, instructions });
});

export const interpretRootOutcome = Effect.fn("Brood.interpretRootOutcome")((
  outcome: AgentOutcome,
  drain: DrainReport,
  maxFailureMessageChars = DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
): Effect.Effect<BroodResult, AgentFailed | RootInterrupted> => {
  switch (outcome._tag) {
    case "Completed":
      return Effect.succeed({ root: outcome.result, drain } satisfies BroodResult);
    case "Failed":
      return Effect.fail(
        new AgentFailed({
          failure: summarizeAgentFailure(outcome.failure, maxFailureMessageChars),
          drain,
        }),
      );
    case "Interrupted":
      return Effect.fail(new RootInterrupted({ reason: outcome.reason, drain }));
  }
});

const makeApplication = Effect.fn("Brood.makeApplication")(function* (runtime: BroodRuntime) {
  const adapter = makePiAdapter({
    workspacePath: runtime.config.workspacePath,
    piAgentDirectory: runtime.config.piAgentDirectory,
    sessionDirectory: runtime.config.sessionDirectory,
    modelRuntime: runtime.modelRuntime,
    sessionCleanupTimeoutMillis: Duration.toMillis(runtime.config.sessionCleanupTimeout),
  });
  const supervisor = yield* makeSupervisor({
    catalogue: runtime.catalogue,
    piAdapter: adapter,
    maxConcurrency: runtime.config.maxConcurrency,
    maxAgentAdmissions: runtime.config.maxAgentAdmissions,
    maxAgentResultChars: runtime.config.maxAgentResultChars,
    maxFailureMessageChars: runtime.config.maxFailureMessageChars,
    maxResumePromptChars: runtime.config.maxResumePromptChars,
    drainTimeoutMillis: Duration.toMillis(runtime.config.drainTimeout),
  });

  const closeSession = yield* Latch.make(false);

  const run = Effect.fn("Brood.run")((
    request: BroodRunRequestEncoded,
    options?: BroodRunOptions,
  ) => {
    const operation = Effect.gen(function* () {
      const normalized = yield* normalizeRunRequest(
        request,
        runtime.config.maxRunInstructionsChars,
      );
      const rootId = yield* supervisor.startRoot(normalized);
      if (options?.session === true) {
        // Session mode: the swarm idles settled after the root finishes —
        // revivable, delegable, and addressable — until the operator closes.
        yield* Latch.await(closeSession);
        const drain = yield* supervisor.drain;
        const resolution = yield* supervisor.latestOutcome(rootId).pipe(Effect.orDie);
        // A close-time interruption never erases delivered work: the latest
        // completed root result wins whenever one exists; the drain report
        // still records what was interrupted.
        const effective: AgentOutcome | undefined =
          resolution.lastCompletedResult === undefined
            ? resolution.outcome
            : { _tag: "Completed", result: resolution.lastCompletedResult };
        if (effective === undefined) {
          return yield* Effect.die(
            new Error("Session close reached a root with no outcome after drain"),
          );
        }
        return yield* interpretRootOutcome(effective, drain, runtime.config.maxFailureMessageChars);
      }
      const rootOutcome = yield* supervisor.awaitOutcome(rootId).pipe(Effect.orDie);
      const drain = yield* supervisor.drain;
      return yield* interpretRootOutcome(rootOutcome, drain, runtime.config.maxFailureMessageChars);
    });
    return runtime.config.logLevel === undefined
      ? operation
      : Effect.provideService(operation, References.MinimumLogLevel, runtime.config.logLevel);
  });

  const controller: BroodController = {
    status: supervisor.status,
    show: supervisor.show,
    interrupt: (reference: string, source: "cli" | "api" = "api") =>
      supervisor.interrupt(reference, source),
    events: supervisor.events,
    bulletins: supervisor.bulletins,
    traffic: supervisor.traffic,
    sendOperatorMessage: supervisor.sendOperatorMessage,
    close: Latch.open(closeSession).pipe(Effect.asVoid),
  };
  const resolved: BroodResolvedPaths = {
    workspacePath: runtime.config.workspacePath,
    stateDirectory: runtime.config.stateDirectory,
    piAgentDirectory: runtime.config.piAgentDirectory,
    sessionDirectory: runtime.config.sessionDirectory,
    piAuth: runtime.authSource,
  };
  return { controller, resolved, run } satisfies BroodApplication;
});

export const makeBroodApplication = (input: BroodConfigEncoded, baseDir?: string) =>
  buildBroodRuntime(input, baseDir).pipe(Effect.flatMap(makeApplication));

/** Unknown-input adapters such as the CLI file loader use the same decoder through this entry point.
 * `baseDir` anchors relative and defaulted paths — pass the config file's directory. */
export const makeBroodApplicationFromUnknown = (input: unknown, baseDir?: string) =>
  buildBroodRuntimeUnknown(input, baseDir).pipe(Effect.flatMap(makeApplication));

export const runBrood = (
  request: BroodRunRequestEncoded,
  input: BroodConfigEncoded,
  baseDir?: string,
): Effect.Effect<BroodResult, BroodConfigError | RootStartError | AgentFailed | RootInterrupted> =>
  Effect.scoped(
    makeBroodApplication(input, baseDir).pipe(
      Effect.flatMap((application) => application.run(request)),
    ),
  );
