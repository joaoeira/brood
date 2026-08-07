/* oxlint-disable no-underscore-dangle, vitest/no-standalone-expect -- Effect variants use `_tag`; `it.effect` is not recognized by the Vitest lint plugin. */
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
  PiRunError,
  makeAgentId,
  makeAgentName,
  makeProfileName,
  makeToolInvocationId,
  makeWaitId,
  type AgentId,
  type AgentOutcome,
} from "../src/agent.js";
import type { PublicModelProfile } from "../src/profiles.js";
import { makeRegistry } from "../src/registry.js";

const profile: PublicModelProfile = {
  name: makeProfileName("worker"),
  provider: "scripted",
  model: "scripted-small",
  thinkingLevel: "off",
};

const completed = (id: AgentId, summary = "done"): AgentOutcome => ({
  _tag: "Completed",
  result: {
    agentId: id,
    sessionId: `session-${id}`,
    summary,
    truncated: false,
    originalCharacterCount: summary.length,
  },
});

const deterministicIds = () => {
  let agent = 0;
  let wait = 0;
  return {
    nextAgentId: () => makeAgentId(`agent_${++agent}`),
    nextWaitId: () => makeWaitId(`wait_${++wait}`),
  };
};

it.effect("admits exactly maxAgentAdmissions and terminal tombstones never replenish", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [
        { name: makeAgentName("api"), goal: "build api", profile },
        { name: makeAgentName("tests"), goal: "build tests", profile },
      ],
      wait: "none",
    });

    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    yield* registry.settle(admitted.children[1]!.id, completed(admitted.children[1]!.id));

    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-2"),
        children: [{ name: makeAgentName("docs"), goal: "write docs", profile }],
        wait: "none",
      }),
    );
    const snapshot = yield* registry.snapshot;

    expect(rejected._tag).toBe("AgentAdmissionLimitExceeded");
    if (rejected._tag === "AgentAdmissionLimitExceeded") {
      expect(rejected.requested).toBe(1);
      expect(rejected.capacity).toEqual({ limit: 3, used: 3, remaining: 0 });
      expect(rejected.message).toContain("no agents were created");
      expect(rejected.message).toContain("Continue without delegation.");
    }
    expect(snapshot.agents).toHaveLength(3);
    expect(snapshot.admissionCapacity).toEqual({ limit: 3, used: 3, remaining: 0 });
  }),
);

it.effect("keeps completed child names as tombstones", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "none",
    });
    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));

    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-2"),
        children: [{ name: makeAgentName("api"), goal: "rebuild api", profile }],
        wait: "none",
      }),
    );

    expect(rejected._tag).toBe("DelegateRejected");
    if (rejected._tag === "DelegateRejected") {
      expect(rejected.reason).toBe("NameCollision");
    }
  }),
);

it.effect("rejects a duplicate-name batch without creating partial records", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });

    yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-1"),
        children: [
          { name: makeAgentName("api"), goal: "one", profile },
          { name: makeAgentName("api"), goal: "two", profile },
        ],
        wait: "none",
      }),
    );
    const snapshot = yield* registry.snapshot;

    expect(snapshot.agents.map(({ name }) => name)).toEqual([makeAgentName("root")]);
  }),
);

it.effect("rejects a control invocation already committed by delegation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const invocationId = makeToolInvocationId("same-invocation");
    yield* registry.registerBatch({
      parentId: root.id,
      invocationId,
      children: [{ name: makeAgentName("api"), goal: "one", profile }],
      wait: "none",
    });

    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId,
        children: [{ name: makeAgentName("tests"), goal: "two", profile }],
        wait: "none",
      }),
    );
    const snapshot = yield* registry.snapshot;

    expect(rejected._tag).toBe("DelegateRejected");
    if (rejected._tag === "DelegateRejected") {
      expect(rejected.reason).toBe("DuplicateInvocationId");
    }
    expect(snapshot.agents.map(({ name }) => name)).toEqual([
      makeAgentName("root"),
      makeAgentName("api"),
    ]);
  }),
);

it.effect("resumes once when a child completes between wait planning and activation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    yield* registry.markInstalled(root.id);
    expect((yield* registry.takePendingCommand(root.id))._tag).toBe("InitialGoal");
    yield* registry.markStarting(root.id);
    yield* registry.markRunning(root.id);
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "all",
    });

    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    const activation = yield* registry.activateWaits(root.id);
    const command = yield* registry.takePendingCommand(root.id);
    const duplicate = yield* registry.settle(
      admitted.children[0]!.id,
      completed(admitted.children[0]!.id, "late duplicate"),
    );
    const snapshot = yield* registry.snapshot;

    expect(activation._tag).toBe("Resumed");
    expect(command._tag).toBe("Resume");
    expect(Option.isNone(duplicate)).toBe(true);
    expect(snapshot.agents.find(({ id }) => id === root.id)?.hasPendingCommand).toBe(false);
  }),
);

it.effect("resumes once when a child completes after wait activation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    yield* registry.markInstalled(root.id);
    yield* registry.takePendingCommand(root.id);
    yield* registry.markStarting(root.id);
    yield* registry.markRunning(root.id);
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "all",
    });

    const activation = yield* registry.activateWaits(root.id);
    const waiting = yield* registry.snapshot;
    const taker = yield* Effect.forkChild(registry.takePendingCommand(root.id));
    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    const command = yield* Fiber.join(taker);
    const snapshot = yield* registry.snapshot;

    expect(activation._tag).toBe("Waiting");
    expect(waiting.agents.find(({ id }) => id === root.id)?.status).toBe("Waiting");
    expect(waiting.agents.find(({ id }) => id === root.id)?.waitTargets).toEqual([
      admitted.children[0]!.id,
    ]);
    expect(command._tag).toBe("Resume");
    expect(snapshot.agents.find(({ id }) => id === root.id)?.status).toBe("Queued");
  }),
);

it.effect("returns terminal direct children immediately without leaving a stale plan", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "none",
    });
    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));

    const planned = yield* registry.planWait({
      parentId: root.id,
      invocationId: makeToolInvocationId("wait-1"),
      childNames: [makeAgentName("api")],
    });

    expect(planned._tag).toBe("Ready");
    if (planned._tag === "Ready") {
      expect(planned.outcomes.map(({ agentId }) => agentId)).toEqual([admitted.children[0]!.id]);
    }
  }),
);

it.effect("aggregates every planned wait and deduplicates direct-child targets", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    yield* registry.takePendingCommand(root.id);
    yield* registry.markStarting(root.id);
    yield* registry.markRunning(root.id);
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [
        { name: makeAgentName("api"), goal: "build api", profile },
        { name: makeAgentName("tests"), goal: "build tests", profile },
      ],
      wait: "none",
    });
    yield* registry.planWait({
      parentId: root.id,
      invocationId: makeToolInvocationId("wait-1"),
      childNames: [makeAgentName("api"), makeAgentName("api")],
    });
    yield* registry.planWait({
      parentId: root.id,
      invocationId: makeToolInvocationId("wait-2"),
      childNames: [makeAgentName("api"), makeAgentName("tests")],
    });
    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));

    const activation = yield* registry.activateWaits(root.id);
    yield* registry.settle(admitted.children[1]!.id, completed(admitted.children[1]!.id));
    const command = yield* registry.takePendingCommand(root.id);

    expect(activation.targetIds).toEqual([admitted.children[0]!.id, admitted.children[1]!.id]);
    expect(command._tag).toBe("Resume");
    if (command._tag === "Resume") {
      expect(command.outcomes.map(({ agentId }) => agentId)).toEqual(activation.targetIds);
    }
  }),
);

it.effect("shares duplicate invocation detection between delegation and explicit waits", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 8, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const invocationId = makeToolInvocationId("shared-id");
    yield* registry.registerBatch({
      parentId: root.id,
      invocationId,
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "none",
    });

    const rejected = yield* Effect.flip(
      registry.planWait({
        parentId: root.id,
        invocationId,
        childNames: [makeAgentName("api")],
      }),
    );

    expect(rejected._tag).toBe("WaitRejected");
    if (rejected._tag === "WaitRejected") {
      expect(rejected.reason).toBe("DuplicateInvocationId");
    }
  }),
);

it.effect("settles terminal outcome awaiters exactly once", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const awaiter = yield* Effect.forkChild(registry.awaitOutcome(root.id));
    const first = completed(root.id, "first");

    const firstSettlement = yield* registry.settle(root.id, first);
    const duplicateSettlement = yield* registry.settle(root.id, completed(root.id, "second"));
    const observed = yield* Fiber.join(awaiter);
    const snapshot = yield* registry.snapshot;

    expect(Option.getOrUndefined(firstSettlement)).toEqual(first);
    expect(Option.isNone(duplicateSettlement)).toBe(true);
    expect(observed).toEqual(first);
    expect(snapshot.agents[0]?.status).toBe("Completed");
  }),
);

it.effect("tracks pending controller installation independently of terminal state", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const before = yield* registry.snapshot;
    yield* registry.markInstalled(root.id);
    yield* registry.markInstalled(root.id);
    const after = yield* registry.snapshot;

    expect(before.pendingInstallationCount).toBe(1);
    expect(before.agents[0]?.installation).toBe("Pending");
    expect(after.pendingInstallationCount).toBe(0);
    expect(after.agents[0]?.installation).toBe("Installed");
  }),
);

it.effect("preserves the first interruption request and wakes the mailbox", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    yield* registry.takePendingCommand(root.id);
    const taker = yield* Effect.forkChild(Effect.exit(registry.takePendingCommand(root.id)));
    const first = yield* registry.requestInterrupt(root.id, {
      _tag: "OperatorRequested",
      source: "api",
    });
    const second = yield* registry.requestInterrupt(root.id, { _tag: "SupervisorShutdown" });
    const taken = yield* Fiber.join(taker);
    yield* registry.settle(root.id, {
      _tag: "Interrupted",
      reason: { _tag: "SupervisorShutdown" },
    });
    const outcome = yield* registry.awaitOutcome(root.id);
    const snapshot = yield* registry.snapshot;

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(taken._tag).toBe("Failure");
    expect(snapshot.agents[0]?.interruptRequested).toEqual({
      _tag: "OperatorRequested",
      source: "api",
    });
    expect(outcome).toEqual({
      _tag: "Interrupted",
      reason: { _tag: "OperatorRequested", source: "api" },
    });
  }),
);

it.effect("shutdown stops admission and pending-installation settlement reaches quiescence", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "none",
    });
    const quiescence = yield* Effect.forkChild(registry.awaitQuiescence);

    const shutdown = yield* registry.beginShutdown({ _tag: "SupervisorShutdown" });
    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-2"),
        children: [{ name: makeAgentName("tests"), goal: "build tests", profile }],
        wait: "none",
      }),
    );
    const settledIds = yield* registry.settlePendingInstallations({ _tag: "SupervisorShutdown" });
    yield* Fiber.join(quiescence);
    const snapshot = yield* registry.snapshot;

    expect(shutdown).toEqual({
      activeIds: [root.id, admitted.children[0]!.id],
      newlyRequested: [
        { agentId: root.id, reason: { _tag: "SupervisorShutdown" } },
        { agentId: admitted.children[0]!.id, reason: { _tag: "SupervisorShutdown" } },
      ],
    });
    expect(rejected._tag).toBe("DelegateRejected");
    expect(settledIds.map(({ agentId }) => agentId)).toEqual(shutdown.activeIds);
    expect(snapshot.accepting).toBe(false);
    expect(snapshot.nonterminalCount).toBe(0);
    expect(snapshot.pendingInstallationCount).toBe(0);
  }),
);

it.effect("timestamps registry transitions with the Effect clock", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    yield* TestClock.setTime(1_000);
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    yield* TestClock.setTime(2_000);
    yield* registry.markInstalled(root.id);
    const snapshot = yield* registry.snapshot;

    expect(snapshot.agents[0]?.createdAt).toBe(1_000);
    expect(snapshot.agents[0]?.updatedAt).toBe(2_000);
  }),
);

it.effect("reports authoritative capacity and returns it from each batch commit", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    expect(yield* registry.admissionCapacity).toEqual({ limit: 4, used: 0, remaining: 4 });

    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    expect(yield* registry.admissionCapacity).toEqual({ limit: 4, used: 1, remaining: 3 });

    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-capacity"),
      children: [
        { name: makeAgentName("api"), goal: "build api", profile },
        { name: makeAgentName("tests"), goal: "build tests", profile },
      ],
      wait: "none",
    });
    expect(admitted.capacityAfterCommit).toEqual({ limit: 4, used: 3, remaining: 1 });

    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    yield* registry.settle(admitted.children[1]!.id, {
      _tag: "Failed",
      failure: {
        _tag: "AgentRunFailed",
        error: new PiRunError({ agentId: admitted.children[1]!.id, message: "boom" }),
      },
    });
    yield* registry.settle(root.id, {
      _tag: "Interrupted",
      reason: { _tag: "OperatorRequested", source: "api" },
    });
    expect(yield* registry.admissionCapacity).toEqual({ limit: 4, used: 3, remaining: 1 });
  }),
);

it.effect("keeps a limit-rejected invocation retryable with a fitting batch", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const invocationId = makeToolInvocationId("delegate-retry");

    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: root.id,
        invocationId,
        children: [
          { name: makeAgentName("a"), goal: "a", profile },
          { name: makeAgentName("b"), goal: "b", profile },
          { name: makeAgentName("c"), goal: "c", profile },
        ],
        wait: "none",
      }),
    );
    const afterRejection = yield* registry.snapshot;

    expect(rejected._tag).toBe("AgentAdmissionLimitExceeded");
    if (rejected._tag === "AgentAdmissionLimitExceeded") {
      expect(rejected.requested).toBe(3);
      expect(rejected.capacity).toEqual({ limit: 3, used: 1, remaining: 2 });
      expect(rejected.message).toContain("Re-plan with at most 2 tasks");
    }
    expect(afterRejection.agents).toHaveLength(1);

    const retried = yield* registry.registerBatch({
      parentId: root.id,
      invocationId,
      children: [
        { name: makeAgentName("a"), goal: "a", profile },
        { name: makeAgentName("b"), goal: "b", profile },
      ],
      wait: "none",
    });
    expect(retried.capacityAfterCommit).toEqual({ limit: 3, used: 3, remaining: 0 });
  }),
);

it.effect("a serialized transition admits one whole batch when two compete for capacity", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const attempt = (tag: string, names: readonly [string, string]) =>
      Effect.exit(
        registry.registerBatch({
          parentId: root.id,
          invocationId: makeToolInvocationId(tag),
          children: names.map((name) => ({ name: makeAgentName(name), goal: name, profile })),
          wait: "none",
        }),
      );

    // Note: the registry's check-and-commit is one synchronous Ref.modify with
    // no yield point, so these attempts serialize under every schedule; this
    // documents the structural guarantee rather than exercising a real race.
    const results = yield* Effect.all(
      [attempt("delegate-a", ["a1", "a2"]), attempt("delegate-b", ["b1", "b2"])],
      { concurrency: "unbounded" },
    );
    const snapshot = yield* registry.snapshot;

    expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    const failure = results.flatMap((exit) =>
      Exit.isFailure(exit) ? [Cause.findErrorOption(exit.cause)] : [],
    )[0];
    expect(failure !== undefined && Option.isSome(failure)).toBe(true);
    if (failure !== undefined && Option.isSome(failure)) {
      const error = failure.value;
      expect(error._tag).toBe("AgentAdmissionLimitExceeded");
      if (error._tag === "AgentAdmissionLimitExceeded") {
        expect(error.requested).toBe(2);
        expect(error.capacity).toEqual({ limit: 3, used: 3, remaining: 0 });
      }
    }
    const names = snapshot.agents.map(({ name }) => name).sort();
    expect([
      ["a1", "a2", "root"],
      ["b1", "b2", "root"],
    ]).toContainEqual(names);
    expect(snapshot.admissionCapacity).toEqual({ limit: 3, used: 3, remaining: 0 });
  }),
);

it.effect("concurrent fitting batches serialize their commits and cannot over-admit", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 5, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const attempt = (tag: string, names: readonly [string, string]) =>
      registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId(tag),
        children: names.map((name) => ({ name: makeAgentName(name), goal: name, profile })),
        wait: "none",
      });

    const [first, second] = yield* Effect.all(
      [attempt("delegate-a", ["a1", "a2"]), attempt("delegate-b", ["b1", "b2"])],
      { concurrency: "unbounded" },
    );
    const snapshot = yield* registry.snapshot;

    const observed = [first.capacityAfterCommit.used, second.capacityAfterCommit.used].sort();
    expect(observed).toEqual([3, 5]);
    expect(snapshot.admissionCapacity).toEqual({ limit: 5, used: 5, remaining: 0 });
  }),
);
