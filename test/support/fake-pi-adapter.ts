/* oxlint-disable no-underscore-dangle -- Effect domain variants intentionally use `_tag`. */
import { Effect, Latch, Queue, Ref, Stream } from "effect";
import type { Latch as LatchType } from "effect/Latch";
import type { Queue as QueueType } from "effect/Queue";
import { PiOpenError, PiProtocolError, PiRunError, type AgentId } from "../../src/agent.js";
import type { PiRunOutcome, SuspensionMarker } from "../../src/control.js";
import type { PiAdapter, PiAgent, PiOpenRequest, PiSessionEvent } from "../../src/pi-adapter.js";

export type FakeRunStep =
  | {
      readonly _tag: "Complete";
      readonly text: string;
      readonly delivered?: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Suspend";
      readonly markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>];
      readonly delivered?: ReadonlyArray<string>;
    }
  | { readonly _tag: "RunFailure"; readonly message: string }
  | { readonly _tag: "ProtocolFailure"; readonly message: string };

export interface FakeSteerObservation {
  readonly agentId: AgentId;
  readonly text: string;
  readonly accepted: boolean;
}

export interface FakeRunObservation {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly prompt: string;
  readonly runNumber: number;
}

export interface FakePiSnapshot {
  readonly openCount: number;
  readonly activeRuns: number;
  readonly maxActiveRuns: number;
  readonly cleanupCount: number;
  readonly runCounts: ReadonlyMap<AgentId, number>;
  readonly sessionIds: ReadonlyMap<AgentId, string>;
}

export interface FakePiAdapterOptions {
  readonly openFailureMessage?: string;
  readonly openFailureMessageFor?: (
    request: PiOpenRequest,
    openNumber: number,
  ) => string | undefined;
  readonly blockCleanup?: boolean;
}

interface FakeAgentState {
  readonly steps: QueueType<FakeRunStep>;
  readonly cleanup: LatchType;
  readonly events: QueueType<PiSessionEvent>;
  readonly sessionId: string;
  readonly eventSequence: number;
  readonly runCount: number;
}

interface FakeState {
  readonly agents: ReadonlyMap<AgentId, FakeAgentState>;
  readonly openCount: number;
  readonly activeRuns: number;
  readonly maxActiveRuns: number;
  readonly cleanupCount: number;
}

export interface FakePiAdapter extends PiAdapter {
  readonly nextOpen: Effect.Effect<PiOpenRequest>;
  readonly nextRun: Effect.Effect<FakeRunObservation>;
  readonly nextSteer: Effect.Effect<FakeSteerObservation>;
  readonly nextCleanup: Effect.Effect<AgentId>;
  readonly complete: (
    agentId: AgentId,
    text: string,
    delivered?: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly suspend: (
    agentId: AgentId,
    markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>],
    delivered?: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly failRun: (agentId: AgentId, message: string) => Effect.Effect<void>;
  readonly failProtocol: (agentId: AgentId, message: string) => Effect.Effect<void>;
  readonly emitEvent: (agentId: AgentId, type: PiSessionEvent["type"]) => Effect.Effect<void>;
  readonly releaseCleanup: (agentId: AgentId) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<FakePiSnapshot>;
}

export class FakePiInvariantDefect extends Error {
  readonly _tag = "FakePiInvariantDefect";
}

const outcomeForStep = (
  agentId: AgentId,
  step: FakeRunStep,
): Effect.Effect<PiRunOutcome, PiRunError | PiProtocolError> => {
  switch (step._tag) {
    case "Complete":
      return Effect.succeed({
        _tag: "Completed",
        result: {
          finalText: step.text,
          finalMessageId: `message-${agentId}`,
          stopReason: "stop",
        },
        ...(step.delivered === undefined ? {} : { deliveredOperatorMessages: step.delivered }),
      });
    case "Suspend":
      return Effect.succeed({
        _tag: "Suspended",
        markers: step.markers,
        ...(step.delivered === undefined ? {} : { deliveredOperatorMessages: step.delivered }),
      });
    case "RunFailure":
      return Effect.fail(new PiRunError({ agentId, message: step.message }));
    case "ProtocolFailure":
      return Effect.fail(new PiProtocolError({ agentId, message: step.message }));
  }
};

/**
 * Deterministic Pi double: every observed run consumes exactly one scripted step. A test that
 * observes a run must eventually call complete, suspend, failRun, or failProtocol for that agent.
 */
/**
 * Scripting contract: every `agent.run(...)` a scenario triggers blocks on the
 * step queue until the test scripts exactly one of `complete`, `suspend`,
 * `failRun`, or `failProtocol` for it. A forgotten step hangs that test —
 * deterministically, never flakily.
 */
export const makeFakePiAdapter = Effect.fn("Brood.Test.makeFakePiAdapter")(function* (
  options: FakePiAdapterOptions = {},
) {
  const opened = yield* Queue.unbounded<PiOpenRequest>();
  const runs = yield* Queue.unbounded<FakeRunObservation>();
  const steers = yield* Queue.unbounded<FakeSteerObservation>();
  const cleanups = yield* Queue.unbounded<AgentId>();
  const stateRef = yield* Ref.make<FakeState>({
    agents: new Map(),
    openCount: 0,
    activeRuns: 0,
    maxActiveRuns: 0,
    cleanupCount: 0,
  });

  const agentState = Effect.fn("Brood.Test.FakePi.agentState")(function* (agentId: AgentId) {
    const state = yield* Ref.get(stateRef);
    const agent = state.agents.get(agentId);
    if (agent === undefined) {
      return yield* Effect.die(new FakePiInvariantDefect(`Agent ${agentId} has not opened`));
    }
    return agent;
  });

  const offerStep = Effect.fn("Brood.Test.FakePi.offerStep")(function* (
    agentId: AgentId,
    step: FakeRunStep,
  ) {
    const agent = yield* agentState(agentId);
    yield* Queue.offer(agent.steps, step);
  });

  const open = Effect.fn("Brood.Test.FakePi.open")(function* (request: PiOpenRequest) {
    const openNumber = yield* Ref.modify(stateRef, (state) => [
      state.openCount + 1,
      { ...state, openCount: state.openCount + 1 },
    ]);
    yield* Queue.offer(opened, request);
    const openFailureMessage =
      options.openFailureMessageFor?.(request, openNumber) ?? options.openFailureMessage;
    if (openFailureMessage !== undefined) {
      return yield* Effect.fail(
        new PiOpenError({ agentId: request.agentId, message: openFailureMessage }),
      );
    }

    const steps = yield* Queue.unbounded<FakeRunStep>();
    const events = yield* Queue.unbounded<PiSessionEvent>();
    const cleanup = yield* Latch.make(options.blockCleanup !== true);
    const sessionId = `fake-session-${openNumber}`;
    yield* Ref.update(stateRef, (state) => {
      const agents = new Map(state.agents);
      agents.set(request.agentId, {
        steps,
        cleanup,
        events,
        sessionId,
        eventSequence: 0,
        runCount: 0,
      });
      return { ...state, agents };
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Latch.await(cleanup);
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          cleanupCount: state.cleanupCount + 1,
        }));
        yield* Queue.offer(cleanups, request.agentId);
      }),
    );

    // Mirrors the real adapter: steers are accepted only while a run is in
    // flight, and the caller sees the refusal synchronously.
    const live = { active: false };
    const run = Effect.fn("Brood.Test.FakePi.run")((prompt: string) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          live.active = true;
        });
        const runNumber = yield* Ref.modify(stateRef, (state) => {
          const current = state.agents.get(request.agentId);
          if (current === undefined) {
            throw new FakePiInvariantDefect(`Agent ${request.agentId} disappeared`);
          }
          const agents = new Map(state.agents);
          const nextRunNumber = current.runCount + 1;
          agents.set(request.agentId, { ...current, runCount: nextRunNumber });
          const activeRuns = state.activeRuns + 1;
          return [
            nextRunNumber,
            {
              ...state,
              agents,
              activeRuns,
              maxActiveRuns: Math.max(state.maxActiveRuns, activeRuns),
            },
          ];
        });
        yield* Queue.offer(runs, {
          agentId: request.agentId,
          sessionId,
          prompt,
          runNumber,
        });
        const step = yield* Queue.take(steps);
        return yield* outcomeForStep(request.agentId, step);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            live.active = false;
          }).pipe(
            Effect.andThen(
              Ref.update(stateRef, (state) => ({
                ...state,
                activeRuns: state.activeRuns - 1,
              })),
            ),
          ),
        ),
      ),
    );

    const steer = (renderedMessage: string): boolean => {
      const accepted = live.active;
      Queue.offerUnsafe(steers, {
        agentId: request.agentId,
        text: renderedMessage,
        accepted,
      });
      return accepted;
    };

    return {
      sessionId,
      events: Stream.fromQueue(events),
      run,
      steer,
    } satisfies PiAgent;
  });

  const emitEvent = Effect.fn("Brood.Test.FakePi.emitEvent")(function* (
    agentId: AgentId,
    type: PiSessionEvent["type"],
  ) {
    const event = yield* Ref.modify(stateRef, (state) => {
      const agent = state.agents.get(agentId);
      if (agent === undefined) throw new FakePiInvariantDefect(`Agent ${agentId} disappeared`);
      const agents = new Map(state.agents);
      const sessionSequence = agent.eventSequence + 1;
      agents.set(agentId, { ...agent, eventSequence: sessionSequence });
      return [
        {
          agentId,
          sessionId: agent.sessionId,
          sessionSequence,
          type,
        } satisfies PiSessionEvent,
        { ...state, agents },
      ];
    });
    const agent = yield* agentState(agentId);
    yield* Queue.offer(agent.events, event);
  });

  const releaseCleanup = Effect.fn("Brood.Test.FakePi.releaseCleanup")(function* (
    agentId: AgentId,
  ) {
    const agent = yield* agentState(agentId);
    yield* Latch.open(agent.cleanup);
  });

  const snapshot = Ref.get(stateRef).pipe(
    Effect.map((state): FakePiSnapshot => ({
      openCount: state.openCount,
      activeRuns: state.activeRuns,
      maxActiveRuns: state.maxActiveRuns,
      cleanupCount: state.cleanupCount,
      runCounts: new Map(
        Array.from(state.agents, ([agentId, agent]) => [agentId, agent.runCount] as const),
      ),
      sessionIds: new Map(
        Array.from(state.agents, ([agentId, agent]) => [agentId, agent.sessionId] as const),
      ),
    })),
  );

  return {
    open,
    nextOpen: Queue.take(opened),
    nextRun: Queue.take(runs),
    nextSteer: Queue.take(steers),
    nextCleanup: Queue.take(cleanups),
    complete: (agentId, text, delivered?) =>
      offerStep(agentId, {
        _tag: "Complete",
        text,
        ...(delivered === undefined ? {} : { delivered }),
      }),
    suspend: (agentId, markers, delivered?) =>
      offerStep(agentId, {
        _tag: "Suspend",
        markers,
        ...(delivered === undefined ? {} : { delivered }),
      }),
    failRun: (agentId, message) => offerStep(agentId, { _tag: "RunFailure", message }),
    failProtocol: (agentId, message) => offerStep(agentId, { _tag: "ProtocolFailure", message }),
    emitEvent,
    releaseCleanup,
    snapshot,
  } satisfies FakePiAdapter;
});
