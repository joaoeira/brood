/**
 * Programmatic entry point: composes runtime, supervisor, and Pi adapter into
 * a scoped BroodApplication, and interprets the root's value-level outcome
 * into BroodResult | AgentFailed | RootInterrupted after draining orphans.
 */
import { Duration, Effect, References, type PubSub, type Scope } from "effect";
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
  /** Deliver a direct operator message; wakes a parked recipient. */
  readonly sendOperatorMessage: (
    reference: string,
    body: string,
  ) => Effect.Effect<OperatorMessageDelivery, UnknownAgentReference | OperatorMessageRejected>;
}

export interface BroodApplication {
  readonly controller: BroodController;
  readonly run: (
    request: BroodRunRequestEncoded,
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

  const run = Effect.fn("Brood.run")((request: BroodRunRequestEncoded) => {
    const operation = Effect.gen(function* () {
      const normalized = yield* normalizeRunRequest(
        request,
        runtime.config.maxRunInstructionsChars,
      );
      const rootId = yield* supervisor.startRoot(normalized);
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
  };
  return { controller, run } satisfies BroodApplication;
});

export const makeBroodApplication = (input: BroodConfigEncoded) =>
  buildBroodRuntime(input).pipe(Effect.flatMap(makeApplication));

/** Unknown-input adapters such as the CLI file loader use the same decoder through this entry point. */
export const makeBroodApplicationFromUnknown = (input: unknown) =>
  buildBroodRuntimeUnknown(input).pipe(Effect.flatMap(makeApplication));

export const runBrood = (
  request: BroodRunRequestEncoded,
  input: BroodConfigEncoded,
): Effect.Effect<BroodResult, BroodConfigError | RootStartError | AgentFailed | RootInterrupted> =>
  Effect.scoped(
    makeBroodApplication(input).pipe(Effect.flatMap((application) => application.run(request))),
  );
