/* oxlint-disable no-underscore-dangle, vitest/no-standalone-expect -- Effect variants use `_tag`; `it.effect` is not recognized by the Vitest lint plugin. */
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  makeAgentId,
  makeAgentName,
  makeProfileName,
  makeToolInvocationId,
  makeWaitId,
  type AgentId,
  type AgentOutcome,
  type PublicModelProfile,
} from "../src/agent.js";
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

it.effect("admits exactly maxAgents and terminal tombstones do not replenish the budget", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 3, ...deterministicIds() });
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

    expect(rejected._tag).toBe("DelegateRejected");
    if (rejected._tag === "DelegateRejected") {
      expect(rejected.reason).toBe("AgentLimitExceeded");
    }
    expect(snapshot.agents).toHaveLength(3);
  }),
);

it.effect("keeps completed child names as tombstones", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 4, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    expect(duplicate).toBe(false);
    expect(snapshot.agents.find(({ id }) => id === root.id)?.hasPendingCommand).toBe(false);
  }),
);

it.effect("resumes once when a child completes after wait activation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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

it.effect("treats repeated early mailbox wakes as hints and still consumes one command", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });

    yield* registry.signalMailbox(root.id);
    yield* registry.signalMailbox(root.id);
    const command = yield* registry.takePendingCommand(root.id);
    const secondTake = yield* Effect.forkChild(Effect.exit(registry.takePendingCommand(root.id)));
    yield* registry.signalMailbox(root.id);
    yield* registry.requestInterrupt(root.id, { _tag: "SupervisorShutdown" });
    const secondExit = yield* Fiber.join(secondTake);

    expect(command._tag).toBe("InitialGoal");
    expect(secondExit._tag).toBe("Failure");
  }),
);

it.effect("aggregates every planned wait and deduplicates direct-child targets", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 8, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 2, ...deterministicIds() });
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

    expect(firstSettlement).toBe(true);
    expect(duplicateSettlement).toBe(false);
    expect(observed).toEqual(first);
    expect(snapshot.agents[0]?.status).toBe("Completed");
  }),
);

it.effect("tracks pending controller installation independently of terminal state", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const before = yield* registry.snapshot;
    const installed = yield* registry.markInstalled(root.id);
    const duplicate = yield* registry.markInstalled(root.id);
    const after = yield* registry.snapshot;

    expect(before.pendingInstallationCount).toBe(1);
    expect(before.agents[0]?.installation).toBe("Pending");
    expect(installed).toBe(true);
    expect(duplicate).toBe(false);
    expect(after.pendingInstallationCount).toBe(0);
    expect(after.agents[0]?.installation).toBe("Installed");
  }),
);

it.effect("preserves the first interruption request and wakes the mailbox", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgents: 2, ...deterministicIds() });
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
    const registry = yield* makeRegistry({ maxAgents: 4, ...deterministicIds() });
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

    const interruptedIds = yield* registry.beginShutdown({ _tag: "SupervisorShutdown" });
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

    expect(interruptedIds).toEqual([root.id, admitted.children[0]!.id]);
    expect(rejected._tag).toBe("DelegateRejected");
    expect(settledIds).toEqual(interruptedIds);
    expect(snapshot.accepting).toBe(false);
    expect(snapshot.nonterminalCount).toBe(0);
    expect(snapshot.pendingInstallationCount).toBe(0);
  }),
);
