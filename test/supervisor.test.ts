/* oxlint-disable no-underscore-dangle, vitest/no-standalone-expect -- Effect variants use `_tag`; `it.effect` is not recognized by the Vitest lint plugin. */
import { it } from "@effect/vitest";
import { Effect, Fiber, Latch, Option, Ref, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { makeAgentName, makeToolInvocationId } from "../src/agent.js";
import { compileProfileCatalogue } from "../src/profiles.js";
import { makeSupervisor } from "../src/supervisor.js";
import type { PiAdapter } from "../src/pi-adapter.js";
import { makeFakePiAdapter } from "./support/fake-pi-adapter.js";
import {
  testModelLookup,
  testProfile,
  testProfilesConfig,
  testSupervisorConfig,
} from "./support/profiles.js";

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
        ...testSupervisorConfig(),
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
          ...testSupervisorConfig(),
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

it.effect("reports bounded capacity and a canonical wait tree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        ...testSupervisorConfig({ maxConcurrency: 1, maxAgents: 4 }),
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      const delegated = yield* supervisor.toolPort.delegate(
        rootId,
        makeToolInvocationId("delegate-status"),
        [{ name: makeAgentName("api"), goal: "build the api" }],
        "all",
      );
      const child = delegated.agents[0];
      if (child === undefined) return yield* Effect.die(new Error("child was not registered"));
      yield* fake.suspend(rootId);
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* TestClock.adjust(2_500);

      const status = yield* supervisor.status;

      expect(JSON.stringify(status)).not.toContain("agent_");
      expect(status).toEqual({
        version: 1,
        state: "running",
        elapsedMillis: 2_500,
        capacity: {
          agents: { admitted: 2, limit: 4, remaining: 2 },
          runs: { active: 1, limit: 1, available: 0 },
        },
        counts: {
          starting: 0,
          queued: 0,
          running: 1,
          waiting: 1,
          completed: 0,
          failed: 0,
          interrupted: 0,
        },
        agents: [
          {
            path: "root",
            name: "root",
            state: "waiting",
            durationMillis: 2_500,
            waitTargets: ["root/api"],
            children: [
              {
                path: "root/api",
                name: "api",
                state: "running",
                durationMillis: 2_500,
                waitTargets: [],
                children: [],
              },
            ],
          },
        ],
      });

      yield* fake.complete(child.id, "api complete");
      yield* fake.nextRun;
      yield* fake.complete(rootId, "root complete");
      yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;
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
        ...testSupervisorConfig({ maxConcurrency: 2 }),
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
        ...testSupervisorConfig({ maxAgents: 2 }),
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const status = yield* supervisor.status;
      const drain = yield* supervisor.drain;

      expect(outcome._tag).toBe("Failed");
      if (outcome._tag === "Failed") {
        expect(outcome.failure._tag).toBe("AgentStartFailed");
      }
      expect(status.agents[0]?.state).toBe("failed");
      expect(drain.terminalAgentCount).toBe(1);
    }),
  ),
);

it.effect("keeps status outcome-free and exposes bounded detail by path or ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const catalogue = yield* compileProfileCatalogue(
        testProfilesConfig(),
        testModelLookup(),
        4_000,
      );
      const fake = yield* makeFakePiAdapter();
      const supervisor = yield* makeSupervisor({
        catalogue,
        piAdapter: fake,
        ...testSupervisorConfig({ maxAgents: 2 }),
      });

      const rootId = yield* supervisor.startRoot("coordinate");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* TestClock.adjust(750);
      yield* fake.complete(rootId, "bounded result summary");
      yield* supervisor.awaitOutcome(rootId);

      const status = yield* supervisor.status;
      const byPath = yield* supervisor.show("root");
      const byId = yield* supervisor.show(rootId);

      expect(status.counts.completed).toBe(1);
      expect(status.agents[0]).not.toHaveProperty("outcome");
      expect(JSON.stringify(status)).not.toContain("bounded result summary");
      expect(byPath).toEqual(byId);
      expect(byPath).toMatchObject({
        version: 1,
        path: "root",
        id: rootId,
        state: "completed",
        durationMillis: 750,
        outcome: {
          _tag: "Completed",
          result: { summary: "bounded result summary" },
        },
      });

      const unknown = yield* supervisor.show("root/missing").pipe(Effect.flip);
      expect(unknown).toMatchObject({ _tag: "UnknownAgentReference", reference: "root/missing" });
      yield* supervisor.drain;
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
        ...testSupervisorConfig({ maxAgents: 2 }),
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
        ...testSupervisorConfig({ maxAgents: 2 }),
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
        ...testSupervisorConfig({ maxConcurrency: 2, maxAgents: 4 }),
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
        ...testSupervisorConfig({ maxAgents: 2 }),
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
        ...testSupervisorConfig({ maxAgents: 2, drainTimeoutMillis: 1_000 }),
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

it.effect("publishes authoritative interruption and timeout events when operator races drain", () =>
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
        ...testSupervisorConfig({ maxAgents: 2, drainTimeoutMillis: 1_000 }),
      });
      const lifecycleSubscription = yield* supervisor.events;
      const lifecycle = yield* Stream.fromSubscription(lifecycleSubscription).pipe(
        Stream.filter((event) => event.source === "supervisor"),
        Stream.tap((event) =>
          event.type === "DrainStarted" ? Latch.open(drainStarted) : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "DrainCompleted"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const rootId = yield* supervisor.startRoot("coordinate");
      yield* Latch.await(runStarted);
      const interruption = yield* Effect.forkChild(supervisor.interrupt(rootId, "api"));
      yield* Latch.await(runInterrupted);
      const draining = yield* Effect.forkChild(supervisor.drain);
      yield* Latch.await(drainStarted);
      const statusWhileDraining = yield* supervisor.status;
      yield* TestClock.adjust(1_000);
      yield* Latch.open(releaseInterruption);
      yield* Fiber.join(interruption);
      const report = yield* Fiber.join(draining);
      const statusAfterDrain = yield* supervisor.status;
      const outcome = yield* supervisor.awaitOutcome(rootId);
      const events = Array.from(yield* Fiber.join(lifecycle));
      const interruptEvents = events.filter((event) => event.type === "AgentInterruptRequested");
      const timeoutEvent = events.find((event) => event.type === "DrainTimedOut");

      expect(interruptEvents).toEqual([
        expect.objectContaining({
          agentId: rootId,
          reason: { _tag: "OperatorRequested", source: "api" },
        }),
      ]);
      expect(timeoutEvent).toEqual(
        expect.objectContaining({
          type: "DrainTimedOut",
          timeoutMillis: 1_000,
          interruptedAgentIds: [rootId],
        }),
      );
      expect(statusWhileDraining.state).toBe("draining");
      expect(statusAfterDrain.state).toBe("completed");
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
        ...testSupervisorConfig({ maxAgents: 2 }),
      });
      const lifecycleSubscription = yield* supervisor.events;
      const lifecycle = yield* Stream.fromSubscription(lifecycleSubscription).pipe(
        Stream.filter((event) => event.source === "supervisor"),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      const piSubscription = yield* supervisor.events;
      const piEvent = yield* Stream.fromSubscription(piSubscription).pipe(
        Stream.filter((event) => event.source === "pi"),
        Stream.runHead,
        Effect.forkChild,
      );
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
        ...testSupervisorConfig({ maxAgents: 2 }),
      });

      const error = yield* supervisor.startRoot(" \n ").pipe(Effect.flip);
      const status = yield* supervisor.status;

      expect(error._tag).toBe("RootStartError");
      expect(status.agents).toEqual([]);
    }),
  ),
);

it.effect("redacts controller defects in agent detail", () =>
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
        ...testSupervisorConfig({ maxAgents: 2 }),
      });

      const rootId = yield* supervisor.startRoot("work");
      yield* supervisor.awaitOutcome(rootId);
      const detail = yield* supervisor.show(rootId);
      const status = yield* supervisor.status;
      const serialized = JSON.stringify(detail);

      expect(detail.outcome).toMatchObject({
        _tag: "Failed",
        code: "AgentDefect",
      });
      expect(serialized).not.toContain("SECRET_TOKEN");
      expect(serialized).not.toContain("/private/operator/path");
      expect(JSON.stringify(status)).not.toContain("SECRET_TOKEN");
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
        ...testSupervisorConfig({ maxAgents: 2 }),
        eventBufferCapacity: 1,
      });
      const firstSeen = yield* Latch.make(false);
      const releaseFirst = yield* Latch.make(false);
      const count = yield* Ref.make(0);
      const monitorSubscription = yield* supervisor.events;
      const monitor = yield* Stream.fromSubscription(monitorSubscription).pipe(
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
      const rootId = yield* supervisor.startRoot("work");
      yield* fake.nextOpen;
      yield* fake.nextRun;
      yield* Latch.await(firstSeen);
      yield* fake.complete(rootId, "done");
      yield* supervisor.awaitOutcome(rootId);
      yield* supervisor.drain;
      yield* Latch.open(releaseFirst);
      const events = Array.from(yield* Fiber.join(monitor));

      expect(events[1]).toMatchObject({ type: "DrainCompleted", sequence: 6 });
    }),
  ),
);
