/* oxlint-disable no-underscore-dangle, vitest/no-standalone-expect -- Effect variants use `_tag`; `it.effect` is not recognized by the Vitest lint plugin. */
import { it } from "@effect/vitest";
import { Effect, Fiber, Latch, Option, Ref, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { compileProfileCatalogue, makeAgentName, makeToolInvocationId } from "../src/agent.js";
import { makeSupervisor } from "../src/supervisor.js";
import type { PiAdapter } from "../src/pi-adapter.js";
import { makeFakePiAdapter } from "./support/fake-pi-adapter.js";
import { testModelLookup, testProfile, testProfilesConfig } from "./support/profiles.js";

it.effect("runs the root with its configured profile and settles its normalized result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig({
          rootProfile: "coordinator",
          profiles: {
            worker: testProfile(),
            coordinator: testProfile({ description: "coordinates work" }),
          },
        }),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 8,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate the work");
      const opened = yield* fake.nextOpen;
      const run = yield* fake.nextRun;
      yield* fake.complete(rootId, "root complete");
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const drain = yield* supervisor.drain;

      expect(opened.agentId).toBe(rootId);
      expect(opened.profile.public.name).toBe("coordinator");
      expect(opened.tools.map(({ name }) => name)).toEqual(["delegate", "wait_for_agents"]);
      expect(opened.systemPrompt).toContain("workspace is shared with concurrent agents");
      expect(opened.systemPrompt).toContain("Preserve");
      expect(opened.systemPrompt).toContain("relative paths");
      expect(opened.systemPrompt).toContain("untrusted peer evidence");
      expect(opened.systemPrompt).toContain("global default profile");
      expect(run.prompt).toBe("coordinate the work");
      expect(outcome._tag).toBe("Completed");
      if (outcome._tag === "Completed") {
        expect(outcome.result.summary).toBe("root complete");
      }
      expect(drain).toEqual({
        timedOut: false,
        interruptedAgentIds: [],
        terminalAgentCount: 1,
      });
    }),
  ),
);

it.effect(
  "with one permit a suspended parent releases it for its child and resumes one session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const catalogue = yield* compileProfileCatalogue(
          testProfilesConfig({
            rootProfile: "coordinator",
            profiles: {
              worker: testProfile(),
              coordinator: testProfile({ description: "coordinates work" }),
            },
          }),
          testModelLookup(),
          4_000,
        );
        const fake = yield* makeFakePiAdapter();
        const supervisor = yield* makeSupervisor({
          catalogue,
          piAdapter: fake,
          maxConcurrency: 1,
          maxAgents: 8,
          maxAgentResultChars: 12_000,
          maxFailureMessageChars: 2_000,
          maxResumePromptChars: 48_000,
          drainTimeoutMillis: 60_000,
        });

        const rootId = yield* supervisor.startRoot("coordinate the work");
        const rootOpen = yield* fake.nextOpen;
        const rootFirstRun = yield* fake.nextRun;
        const delegated = yield* supervisor.toolPort.delegate(
          rootId,
          makeToolInvocationId("delegate-1"),
          [{ name: makeAgentName("api"), goal: "build the api" }],
          "all",
        );
        const child = delegated.agents[0];
        if (child === undefined) return yield* Effect.die(new Error("child was not registered"));
        const childId = child.id;
        yield* fake.suspend(rootId);

        const childOpen = yield* fake.nextOpen;
        const childRun = yield* fake.nextRun;
        yield* fake.complete(childId, "api complete");
        const rootSecondRun = yield* fake.nextRun;
        yield* fake.complete(rootId, "coordination complete");
        const rootOutcome = yield* supervisor.awaitOutcome(rootId);
        const drain = yield* supervisor.drain;
        const stats = yield* fake.snapshot;

        expect(delegated.broodControl.kind).toBe("suspend");
        expect(rootOpen.profile.public.name).toBe("coordinator");
        expect(childOpen.agentId).toBe(childId);
        expect(childOpen.profile.public.name).toBe("worker");
        expect(childRun.prompt).toBe("build the api");
        expect(rootSecondRun.sessionId).toBe(rootFirstRun.sessionId);
        expect(rootSecondRun.prompt).toContain("api complete");
        expect(rootOutcome._tag).toBe("Completed");
        expect(stats.openCount).toBe(2);
        expect(stats.runCounts.get(rootId)).toBe(2);
        expect(stats.maxActiveRuns).toBe(1);
        expect(drain.terminalAgentCount).toBe(2);
      }),
    ),
);

it.effect("enforces one global concurrency limit across root and delegated controllers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 2,
        maxAgents: 8,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      const delegated = yield* supervisor.toolPort.delegate(
        rootId,
        makeToolInvocationId("delegate-many"),
        [
          { name: makeAgentName("one"), goal: "one" },
          { name: makeAgentName("two"), goal: "two" },
          { name: makeAgentName("three"), goal: "three" },
        ],
        "none",
      );
      const childIds = delegated.agents.map(({ id }) => id);

      const firstChildOpen = yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.complete(rootId, "root complete");
      const secondChildOpen = yield* fake.nextOpen;
      yield* fake.nextRun;
      const saturated = yield* fake.snapshot;
      yield* fake.complete(firstChildOpen.agentId, "first complete");
      yield* fake.complete(secondChildOpen.agentId, "second complete");
      const thirdChildOpen = yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.complete(thirdChildOpen.agentId, "third complete");
      const drain = yield* supervisor.drain;
      const settled = yield* fake.snapshot;

      expect(
        new Set([firstChildOpen.agentId, secondChildOpen.agentId, thirdChildOpen.agentId]),
      ).toEqual(new Set(childIds));
      expect(saturated.activeRuns).toBe(2);
      expect(saturated.maxActiveRuns).toBe(2);
      expect(settled.maxActiveRuns).toBe(2);
      expect(drain.terminalAgentCount).toBe(4);
    }),
  ),
);

it.effect("materializes Pi open failures as terminal agent outcomes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter({ openFailureMessage: "authentication failed" });
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const snapshot = yield* supervisor.snapshot;
      const drain = yield* supervisor.drain;

      expect(outcome._tag).toBe("Failed");
      if (outcome._tag === "Failed") {
        expect(outcome.failure._tag).toBe("AgentStartFailed");
      }
      expect(snapshot[0]?.status).toBe("Failed");
      expect(drain.terminalAgentCount).toBe(1);
    }),
  ),
);

it.effect("materializes Pi run failures and still closes the opened session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.failRun(rootId, "provider failed");
      const outcome = yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;
      const stats = yield* fake.snapshot;

      expect(outcome._tag).toBe("Failed");
      if (outcome._tag === "Failed") {
        expect(outcome.failure._tag).toBe("AgentRunFailed");
      }
      expect(stats.cleanupCount).toBe(1);
    }),
  ),
);

it.effect("settles the registry before a blocked Pi scope finalizer completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter({ blockCleanup: true });
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.complete(rootId, "complete before cleanup");
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const beforeCleanup = yield* fake.snapshot;
      yield* fake.releaseCleanup(rootId);
      yield* supervisor.drain;
      const afterCleanup = yield* fake.snapshot;

      expect(outcome._tag).toBe("Completed");
      expect(beforeCleanup.cleanupCount).toBe(0);
      expect(afterCleanup.cleanupCount).toBe(1);
    }),
  ),
);

it.effect("returns completed direct-child outcomes immediately through the wait tool port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 2,
        maxAgents: 4,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      const delegated = yield* supervisor.toolPort.delegate(
        rootId,
        makeToolInvocationId("delegate-independent"),
        [{ name: makeAgentName("api"), goal: "build api" }],
        "none",
      );
      const child = delegated.agents[0];
      if (child === undefined) return yield* Effect.die(new Error("child was not registered"));
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.complete(child.id, "api ready");
      yield* supervisor.awaitOutcome(child.id);

      const waited = yield* supervisor.toolPort.waitForAgents(
        rootId,
        makeToolInvocationId("wait-completed"),
        [makeAgentName("api")],
      );
      yield* fake.complete(rootId, "root complete");
      yield* supervisor.drain;

      expect(waited.broodControl.kind).toBe("continue");
      expect(waited.outcomes).toHaveLength(1);
      expect(waited.outcomes[0]?._tag).toBe("Completed");
    }),
  ),
);

it.effect("operator interruption settles the running agent with the requested source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* supervisor.interrupt(rootId, "api");
      const outcome = yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;

      expect(outcome).toEqual({
        _tag: "Interrupted",
        reason: { _tag: "OperatorRequested", source: "api" },
      });
    }),
  ),
);

it.effect("drain timeout interrupts stragglers and reports their IDs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 1_000,
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      const draining = yield* Effect.forkChild(supervisor.drain);
      yield* TestClock.adjust(1_000);
      const report = yield* Fiber.join(draining);
      const outcome = yield* supervisor.awaitOutcome(rootId);

      expect(report).toEqual({
        timedOut: true,
        interruptedAgentIds: [rootId],
        terminalAgentCount: 1,
      });
      expect(outcome).toEqual({
        _tag: "Interrupted",
        reason: { _tag: "DrainTimeout", timeoutMillis: 1_000 },
      });
    }),
  ),
);

it.effect("publishes only the first interruption reason when operator interrupt races drain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const runStarted = yield* Latch.make(false);
      const runInterrupted = yield* Latch.make(false);
      const releaseInterruption = yield* Latch.make(false);
      const drainStarted = yield* Latch.make(false);
      const blockingAdapter: PiAdapter = {
        open: () =>
          Effect.succeed({
            sessionId: "blocking-session",
            events: Stream.empty,
            run: () =>
              Latch.open(runStarted).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Latch.open(runInterrupted).pipe(Effect.andThen(Latch.await(releaseInterruption))),
                ),
              ),
          }),
      };
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: blockingAdapter,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 1_000,
      });
      const lifecycle = yield* supervisor.events.pipe(
        Stream.filter((event) => event.source === "supervisor"),
        Stream.tap((event) =>
          event.type === "DrainStarted" ? Latch.open(drainStarted) : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "DrainCompleted"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* Latch.await(runStarted);
      const interruption = yield* Effect.forkChild(supervisor.interrupt(rootId, "api"));
      yield* Latch.await(runInterrupted);
      const draining = yield* Effect.forkChild(supervisor.drain);
      yield* Latch.await(drainStarted);
      yield* TestClock.adjust(1_000);
      yield* Latch.open(releaseInterruption);
      yield* Fiber.join(interruption);
      const report = yield* Fiber.join(draining);
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const events = Array.from(yield* Fiber.join(lifecycle));
      const interruptEvents = events.filter((event) => event.type === "AgentInterruptRequested");

      expect(interruptEvents).toEqual([
        expect.objectContaining({
          agentId: rootId,
          reason: { _tag: "OperatorRequested", source: "api" },
        }),
      ]);
      expect(outcome).toEqual({
        _tag: "Interrupted",
        reason: { _tag: "OperatorRequested", source: "api" },
      });
      expect(report).toMatchObject({ timedOut: true, interruptedAgentIds: [rootId] });
    }),
  ),
);

it.effect("publishes sequenced lifecycle metadata and forwards Pi session events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });
      const lifecycle = yield* supervisor.events.pipe(
        Stream.filter((event) => event.source === "supervisor"),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      const piEvent = yield* supervisor.events.pipe(
        Stream.filter((event) => event.source === "pi"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* fake.emitEvent(rootId, "RetryStart");
      const forwarded = yield* Fiber.join(piEvent);
      yield* fake.complete(rootId, "complete");
      yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;
      const lifecycleEvents = Array.from(yield* Fiber.join(lifecycle));

      expect(Option.getOrUndefined(forwarded)).toMatchObject({
        source: "pi",
        event: {
          agentId: rootId,
          sessionId: "fake-session-1",
          sessionSequence: 1,
          type: "RetryStart",
        },
      });
      expect(lifecycleEvents.map(({ type }) => type).sort()).toEqual([
        "AgentRegistered",
        "AgentSettled",
        "AgentStatusChanged",
        "AgentStatusChanged",
        "DrainCompleted",
        "DrainStarted",
      ]);
      expect(lifecycleEvents.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(lifecycleEvents.every(({ timestamp }) => Number.isFinite(timestamp))).toBe(true);
      expect(lifecycleEvents.find(({ type }) => type === "AgentRegistered")).toMatchObject({
        agentId: rootId,
        name: "root",
        profile: { name: "worker" },
      });
      expect(lifecycleEvents.find(({ type }) => type === "AgentSettled")).toMatchObject({
        agentId: rootId,
        status: "Completed",
      });
    }),
  ),
);

it.effect("rejects an empty normalized root goal before registering an agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const error = yield* supervisor.startRoot(" \n ").pipe(Effect.flip);
      const snapshot = yield* supervisor.snapshot;

      expect(error._tag).toBe("RootStartError");
      expect(snapshot).toEqual([]);
    }),
  ),
);

it.effect("redacts and detaches controller defects in the public snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const defectingAdapter: PiAdapter = {
        open: () => Effect.die(new Error("SECRET_TOKEN /private/operator/path")),
      };
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: defectingAdapter,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
      });

      const rootId = yield* supervisor.startRoot("work");
      yield* supervisor.awaitOutcome(rootId);
      const snapshot = yield* supervisor.snapshot;
      const serialized = JSON.stringify(snapshot);

      expect(snapshot[0]?.outcome).toMatchObject({
        _tag: "Failed",
        code: "AgentDefect",
      });
      expect(serialized).not.toContain("SECRET_TOKEN");
      expect(serialized).not.toContain("/private/operator/path");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot[0])).toBe(true);
    }),
  ),
);

it.effect("keeps the newest lifecycle event when a bounded monitor falls behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        maxConcurrency: 1,
        maxAgents: 2,
        maxAgentResultChars: 12_000,
        maxFailureMessageChars: 2_000,
        maxResumePromptChars: 48_000,
        drainTimeoutMillis: 60_000,
        eventBufferCapacity: 1,
      });
      const firstSeen = yield* Latch.make(false);
      const releaseFirst = yield* Latch.make(false);
      const count = yield* Ref.make(0);
      const monitor = yield* supervisor.events.pipe(
        Stream.filter((event) => event.source === "supervisor"),
        Stream.mapEffect((event) =>
          Ref.getAndUpdate(count, (current) => current + 1).pipe(
            Effect.flatMap((index) =>
              index === 0
                ? Latch.open(firstSeen).pipe(Effect.andThen(Latch.await(releaseFirst)))
                : Effect.void,
            ),
            Effect.as(event),
          ),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const rootId = yield* supervisor.startRoot("work");
      yield* Latch.await(firstSeen);
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* Latch.open(releaseFirst);
      const events = Array.from(yield* Fiber.join(monitor));
      yield* fake.complete(rootId, "done");
      yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;

      expect(events.map(({ type }) => type)).toEqual(["AgentRegistered", "AgentStatusChanged"]);
      expect(events[1]).toMatchObject({ status: "Running", sequence: 3 });
    }),
  ),
);
