import { Duration, Effect, References, type PubSub, type Scope } from "effect";
import {
  AgentFailed,
  DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
  RootInterrupted,
  summarizeAgentFailure,
  type AgentId,
  type AgentOutcome,
  type BroodResult,
  type BroodConfigError,
  type DrainReport,
  type RootStartError,
  type UnknownAgent,
} from "./agent.js";
import { makePiAdapter } from "./pi-adapter.js";
import {
  buildBroodRuntime,
  buildBroodRuntimeUnknown,
  type BroodConfigEncoded,
  type BroodRuntime,
} from "./runtime.js";
import { makeSupervisor, type AgentSnapshot, type SupervisorEvent } from "./supervisor.js";

export interface BroodController {
  readonly snapshot: Effect.Effect<ReadonlyArray<AgentSnapshot>>;
  readonly interrupt: (id: AgentId, source?: "cli" | "api") => Effect.Effect<void, UnknownAgent>;
  readonly events: Effect.Effect<PubSub.Subscription<SupervisorEvent>, never, Scope.Scope>;
}

export interface BroodApplication {
  readonly controller: BroodController;
  readonly run: (
    goal: string,
  ) => Effect.Effect<BroodResult, AgentFailed | RootInterrupted | RootStartError>;
}

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
    maxAgents: runtime.config.maxAgents,
    maxAgentResultChars: runtime.config.maxAgentResultChars,
    maxFailureMessageChars: runtime.config.maxFailureMessageChars,
    maxResumePromptChars: runtime.config.maxResumePromptChars,
    drainTimeoutMillis: Duration.toMillis(runtime.config.drainTimeout),
  });

  const run = Effect.fn("Brood.run")((goal: string) => {
    const operation = Effect.gen(function* () {
      const rootId = yield* supervisor.startRoot(goal);
      const rootOutcome = yield* supervisor.awaitOutcome(rootId).pipe(Effect.orDie);
      const drain = yield* supervisor.drain;
      return yield* interpretRootOutcome(rootOutcome, drain, runtime.config.maxFailureMessageChars);
    });
    return runtime.config.logLevel === undefined
      ? operation
      : Effect.provideService(operation, References.MinimumLogLevel, runtime.config.logLevel);
  });

  const controller: BroodController = {
    snapshot: supervisor.snapshot,
    interrupt: (id: AgentId, source: "cli" | "api" = "api") => supervisor.interrupt(id, source),
    events: supervisor.events,
  };
  return { controller, run } satisfies BroodApplication;
});

export const makeBroodApplication = (input: BroodConfigEncoded) =>
  buildBroodRuntime(input).pipe(Effect.flatMap(makeApplication));

/** Unknown-input adapters such as the CLI file loader use the same decoder through this entry point. */
export const makeBroodApplicationFromUnknown = (input: unknown) =>
  buildBroodRuntimeUnknown(input).pipe(Effect.flatMap(makeApplication));

export const runBrood = (
  goal: string,
  input: BroodConfigEncoded,
): Effect.Effect<BroodResult, BroodConfigError | RootStartError | AgentFailed | RootInterrupted> =>
  Effect.scoped(
    makeBroodApplication(input).pipe(Effect.flatMap((application) => application.run(goal))),
  );
