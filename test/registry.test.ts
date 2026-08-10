/* oxlint-disable no-underscore-dangle, vitest/no-standalone-expect -- Effect variants use `_tag`; `it.effect` is not recognized by the Vitest lint plugin. */
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Option } from "effect";
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
  type AgentResult,
} from "../src/agent.js";
import {
  MAX_BULLETINS_PER_AUTHOR,
  MAX_REQUEST_TARGETS_PER_WAIT,
  MAX_TOOL_RESULT_CHARS,
  MAX_UNREAD_MESSAGES_PER_AGENT,
  MAX_PENDING_OPERATOR_MESSAGES_PER_AGENT,
  makeOperatorMessageId,
  makeAgentPath,
  makeRequestId,
  type RequestId,
} from "../src/communication.js";
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

const result = (id: AgentId, summary = "done"): AgentResult => ({
  agentId: id,
  sessionId: `session-${id}`,
  summary,
  truncated: false,
  originalCharacterCount: summary.length,
});

const deterministicIds = () => {
  let agent = 0;
  let wait = 0;
  let request = 0;
  return {
    nextAgentId: () => makeAgentId(`agent_${++agent}`),
    nextWaitId: () => makeWaitId(`wait_${++wait}`),
    nextRequestId: () => makeRequestId(`request_${++request}`),
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

it.effect("rejects an overlong derived path before allocating a child ID", () =>
  Effect.gen(function* () {
    let generatedIds = 0;
    const registry = yield* makeRegistry({
      maxAgentAdmissions: 127,
      nextAgentId: () => makeAgentId(`agent_${++generatedIds}`),
      nextWaitId: () => makeWaitId("wait_1"),
      nextRequestId: () => makeRequestId("request_1"),
    });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    let parent = root;
    const longName = makeAgentName("a".repeat(64));
    for (let depth = 1; depth <= 125; depth += 1) {
      const admitted = yield* registry.registerBatch({
        parentId: parent.id,
        invocationId: makeToolInvocationId(`delegate-${depth}`),
        children: [{ name: longName, goal: "deeper", profile }],
        wait: "none",
      });
      parent = admitted.children[0]!;
    }
    expect(parent.path.length).toBe(8_129);
    const beforeRejection = generatedIds;

    const rejected = yield* Effect.flip(
      registry.registerBatch({
        parentId: parent.id,
        invocationId: makeToolInvocationId("delegate-overlong"),
        children: [{ name: longName, goal: "too deep", profile }],
        wait: "none",
      }),
    );

    expect(rejected._tag).toBe("DelegateRejected");
    if (rejected._tag === "DelegateRejected") expect(rejected.reason).toBe("PathTooLong");
    expect(generatedIds).toBe(beforeRejection);
    expect((yield* registry.snapshot).agents).toHaveLength(126);
    const firstPage = yield* registry.listAgents(root.id, {});
    expect(Array.from(JSON.stringify(firstPage)).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(firstPage.nextAfter).toBeDefined();
    const cursor = firstPage.nextAfter;
    if (cursor !== undefined) {
      const secondPage = yield* registry.listAgents(root.id, { after: cursor });
      const nextPath = secondPage.agents[0]?.path;
      expect(nextPath).toBeDefined();
      if (nextPath !== undefined) expect(nextPath > cursor).toBe(true);
    }
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
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.markStarting(root.id);
    const initial = yield* registry.beginRun(root.id, initialClaim.token);
    expect(initial._tag).toBe("Ready");
    if (initial._tag === "Ready") expect(initial.command._tag).toBe("InitialGoal");
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "all",
    });

    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    const activation = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-1"),
          },
        ],
      },
    });
    const resumeClaim = yield* registry.takePendingCommand(root.id);
    const resumed = yield* registry.beginRun(root.id, resumeClaim.token);
    const duplicate = yield* registry.settle(
      admitted.children[0]!.id,
      completed(admitted.children[0]!.id, "late duplicate"),
    );
    const snapshot = yield* registry.snapshot;

    expect(activation._tag).toBe("RunNext");
    expect(resumed._tag).toBe("Ready");
    if (resumed._tag === "Ready") expect(resumed.command._tag).toBe("WaitSatisfied");
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
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.markStarting(root.id);
    yield* registry.beginRun(root.id, initialClaim.token);
    const admitted = yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-1"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "all",
    });

    const activation = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-1"),
          },
        ],
      },
    });
    const waiting = yield* registry.snapshot;
    const childView = yield* registry.listAgents(admitted.children[0]!.id, {});
    const taker = yield* Effect.forkChild(registry.takePendingCommand(root.id));
    yield* registry.settle(admitted.children[0]!.id, completed(admitted.children[0]!.id));
    const resumeClaim = yield* Fiber.join(taker);
    const resumed = yield* registry.beginRun(root.id, resumeClaim.token);
    const snapshot = yield* registry.snapshot;

    expect(activation._tag).toBe("Park");
    expect(waiting.agents.find(({ id }) => id === root.id)?.status).toBe("Waiting");
    expect(waiting.agents.find(({ id }) => id === root.id)?.waitTargets).toEqual([
      admitted.children[0]!.id,
    ]);
    expect(childView.agents.find(({ path }) => path === root.path)).toMatchObject({
      waitingFor: { agentCompletions: 1, replies: 0 },
      waitingForCaller: true,
    });
    expect(resumed._tag).toBe("Ready");
    if (resumed._tag === "Ready") expect(resumed.command._tag).toBe("WaitSatisfied");
    expect(snapshot.agents.find(({ id }) => id === root.id)?.status).toBe("Running");
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
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.markStarting(root.id);
    yield* registry.beginRun(root.id, initialClaim.token);
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

    const activation = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "wait_for_agents",
            invocationId: makeToolInvocationId("wait-1"),
          },
          {
            _tag: "AgentWait",
            tool: "wait_for_agents",
            invocationId: makeToolInvocationId("wait-2"),
          },
        ],
      },
    });
    yield* registry.settle(admitted.children[1]!.id, completed(admitted.children[1]!.id));
    const resumeClaim = yield* registry.takePendingCommand(root.id);
    const resumed = yield* registry.beginRun(root.id, resumeClaim.token);

    expect(activation._tag).toBe("Park");
    expect(resumed._tag).toBe("Ready");
    if (resumed._tag === "Ready" && resumed.command._tag === "WaitSatisfied") {
      expect(resumed.command.dependencies.map(({ agentId }) => agentId)).toEqual([
        admitted.children[0]!.id,
        admitted.children[1]!.id,
      ]);
    }
  }),
);

it.effect("projects only unresolved planned and active wait targets", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, initialClaim.token);
    const dependencies = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-dependencies"),
      children: [
        { name: makeAgentName("done"), goal: "finish first", profile },
        { name: makeAgentName("pending"), goal: "finish later", profile },
      ],
      wait: "all",
    })).children;
    const done = dependencies[0]!;
    const pending = dependencies[1]!;
    const recipient = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-recipient"),
      children: [{ name: makeAgentName("advisor"), goal: "advise", profile }],
      wait: "none",
    })).children[0]!;
    const asked = yield* registry.askAgent(root.id, makeToolInvocationId("ask-advisor"), {
      to: recipient.path,
      question: "Which contract should we use?",
    });
    yield* registry.settle(done.id, completed(done.id));
    yield* registry.replyToRequest(recipient.id, makeToolInvocationId("reply-root"), {
      request: asked.request,
      message: "Use the narrow contract.",
    });

    const planned = yield* registry.snapshot;
    expect(planned.agents.find(({ id }) => id === root.id)?.waitTargets).toEqual([pending.id]);

    const activation = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependencies"),
          },
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-advisor"),
            request: asked.request,
          },
        ],
      },
    });
    const active = yield* registry.snapshot;

    expect(activation).toMatchObject({ _tag: "Park", targetIds: [pending.id] });
    expect(active.agents.find(({ id }) => id === root.id)?.waitTargets).toEqual([pending.id]);
  }),
);

it.effect("rejects a mismatched suspension marker without partially consuming its wait plan", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-api"),
      children: [{ name: makeAgentName("api"), goal: "build api", profile }],
      wait: "all",
    })).children[0]!;

    const rejected = yield* Effect.flip(
      registry.finishTurn({
        agentId: root.id,
        commandToken: claim.token,
        piOutcome: {
          _tag: "Suspended",
          markers: [
            {
              _tag: "RequestWait",
              tool: "ask_agent",
              invocationId: makeToolInvocationId("delegate-api"),
              request: makeRequestId("request_wrong"),
            },
          ],
        },
      }),
    );
    const afterRejection = yield* registry.snapshot;
    const accepted = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-api"),
          },
        ],
      },
    });

    expect(rejected._tag).toBe("PiProtocolError");
    expect(afterRejection.agents.find(({ id }) => id === root.id)?.status).toBe("Running");
    expect(accepted).toMatchObject({ _tag: "Park", targetIds: [child.id] });
  }),
);

it.effect("rejects the exact suspension-marker matrix atomically across turns", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);
    const firstTurnChildren = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-first-turn"),
      children: [
        { name: makeAgentName("api"), goal: "api", profile },
        { name: makeAgentName("tests"), goal: "tests", profile },
      ],
      wait: "none",
    })).children;
    yield* registry.planWait({
      parentId: root.id,
      invocationId: makeToolInvocationId("wait-api"),
      childNames: [makeAgentName("api")],
    });
    yield* registry.planWait({
      parentId: root.id,
      invocationId: makeToolInvocationId("wait-tests"),
      childNames: [makeAgentName("tests")],
    });
    const apiMarker = {
      _tag: "AgentWait" as const,
      tool: "wait_for_agents" as const,
      invocationId: makeToolInvocationId("wait-api"),
    };
    const testsMarker = {
      _tag: "AgentWait" as const,
      tool: "wait_for_agents" as const,
      invocationId: makeToolInvocationId("wait-tests"),
    };
    const reject = (markers: readonly [typeof apiMarker, ...Array<typeof apiMarker>]) =>
      Effect.flip(
        registry.finishTurn({
          agentId: root.id,
          commandToken: claim.token,
          piOutcome: { _tag: "Suspended", markers },
        }),
      );

    const missing = yield* reject([apiMarker]);
    const extra = yield* reject([
      apiMarker,
      testsMarker,
      { ...apiMarker, invocationId: makeToolInvocationId("wait-extra") },
    ]);
    const duplicate = yield* reject([apiMarker, apiMarker, testsMarker]);
    const completedWithPlans = yield* Effect.flip(
      registry.finishTurn({
        agentId: root.id,
        commandToken: claim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "premature", finalMessageId: "root-1", stopReason: "stop" },
        },
        completedResult: result(root.id, "premature"),
      }),
    );
    const afterRejectedMatrix = yield* registry.snapshot;
    const parked = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: { _tag: "Suspended", markers: [apiMarker, testsMarker] },
    });

    for (const rejected of [missing, extra, duplicate, completedWithPlans]) {
      expect(rejected._tag).toBe("PiProtocolError");
    }
    expect(afterRejectedMatrix.agents.find(({ id }) => id === root.id)).toMatchObject({
      status: "Running",
      waitTargets: firstTurnChildren.map(({ id }) => id),
    });
    expect(parked).toMatchObject({
      _tag: "Park",
      targetIds: firstTurnChildren.map(({ id }) => id),
    });

    yield* Effect.forEach(
      firstTurnChildren,
      (child) => registry.settle(child.id, completed(child.id)),
      { discard: true },
    );
    const resumedClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, resumedClaim.token);
    const currentChild = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-current-turn"),
      children: [{ name: makeAgentName("docs"), goal: "docs", profile }],
      wait: "all",
    })).children[0]!;
    const currentMarker = {
      _tag: "AgentWait" as const,
      tool: "delegate" as const,
      invocationId: makeToolInvocationId("delegate-current-turn"),
    };
    const crossTurn = yield* Effect.flip(
      registry.finishTurn({
        agentId: root.id,
        commandToken: resumedClaim.token,
        piOutcome: { _tag: "Suspended", markers: [apiMarker, currentMarker] },
      }),
    );
    const afterCrossTurn = yield* registry.snapshot;
    const currentPark = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: resumedClaim.token,
      piOutcome: { _tag: "Suspended", markers: [currentMarker] },
    });

    expect(crossTurn._tag).toBe("PiProtocolError");
    expect(afterCrossTurn.agents.find(({ id }) => id === root.id)).toMatchObject({
      status: "Running",
      waitTargets: [currentChild.id],
    });
    expect(currentPark).toMatchObject({ _tag: "Park", targetIds: [currentChild.id] });
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

it.effect("commits ordinary completion atomically inside finishTurn", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 1, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);
    const expected = result(root.id, "complete");

    const decision = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Completed",
        result: { finalText: "complete", finalMessageId: "root-1", stopReason: "stop" },
      },
      completedResult: expected,
    });
    const duplicate = yield* registry.settle(root.id, completed(root.id, "duplicate"));

    expect(decision).toEqual({ _tag: "Settled", outcome: { _tag: "Completed", result: expected } });
    if (decision._tag !== "Settled") throw new Error("Expected finishTurn to settle the agent");
    expect(yield* registry.awaitOutcome(root.id)).toEqual(decision.outcome);
    expect(Option.isNone(duplicate)).toBe(true);
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

it.effect("preserves the first interruption request before a claimed command begins", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    const first = yield* registry.requestInterrupt(root.id, {
      _tag: "OperatorRequested",
      source: "api",
    });
    const second = yield* registry.requestInterrupt(root.id, { _tag: "SupervisorShutdown" });
    const begun = yield* Effect.exit(registry.beginRun(root.id, claim.token));
    yield* registry.settle(root.id, {
      _tag: "Interrupted",
      reason: { _tag: "SupervisorShutdown" },
    });
    const outcome = yield* registry.awaitOutcome(root.id);
    const snapshot = yield* registry.snapshot;

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(begun._tag).toBe("Failure");
    if (begun._tag === "Failure") {
      const failure = Cause.findErrorOption(begun.cause);
      expect(Option.isSome(failure) && failure.value._tag).toBe("CommandInterrupted");
    }
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

it.effect("indexes every addressable agent by its stable canonical path", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 5, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const [api, tests] = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-children"),
      children: [
        { name: makeAgentName("api"), goal: "api", profile },
        { name: makeAgentName("tests"), goal: "tests", profile },
      ],
      wait: "none",
    })).children;
    if (api === undefined || tests === undefined) return yield* Effect.die("missing children");
    yield* registry.registerBatch({
      parentId: api.id,
      invocationId: makeToolInvocationId("delegate-audit"),
      children: [{ name: makeAgentName("audit"), goal: "audit", profile }],
      wait: "none",
    });

    const directory = yield* registry.listAgents(root.id, {});

    expect(root.path).toBe(makeAgentPath("root"));
    expect(directory.self).toEqual({ path: makeAgentPath("root") });
    expect(directory.agents.map(({ path }) => path)).toEqual([
      makeAgentPath("root/api"),
      makeAgentPath("root/api/audit"),
      makeAgentPath("root/tests"),
    ]);
  }),
);

it.effect("projects replaceable activity without changing lifecycle state", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("api"), goal: "api", profile }],
      wait: "none",
    })).children[0]!;

    yield* registry.setActivity(child.id, makeToolInvocationId("activity-1"), {
      activity: "checking the API",
    });
    const visible = yield* registry.listAgents(root.id, {});
    const stateBeforeClear = (yield* registry.snapshot).agents.find(({ id }) => id === child.id);
    yield* registry.setActivity(child.id, makeToolInvocationId("activity-2"), {
      activity: null,
    });
    const cleared = yield* registry.listAgents(root.id, {});
    yield* registry.setActivity(child.id, makeToolInvocationId("activity-3"), {
      activity: "finishing",
    });
    yield* registry.settle(child.id, completed(child.id));
    const terminal = (yield* registry.snapshot).agents.find(({ id }) => id === child.id);

    expect(visible.agents[0]?.activity).toBe("checking the API");
    expect(stateBeforeClear?.status).toBe("Queued");
    expect(cleared.agents[0]?.activity).toBeUndefined();
    expect(terminal?.activity).toBeUndefined();
  }),
);

it.effect("delivers passive messages across branches once without waking the recipient", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const children = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-children"),
      children: [
        { name: makeAgentName("api"), goal: "api", profile },
        { name: makeAgentName("tests"), goal: "tests", profile },
      ],
      wait: "none",
    })).children;
    const api = children[0]!;
    const tests = children[1]!;

    const accepted = yield* registry.sendMessage(api.id, makeToolInvocationId("message-1"), {
      to: tests.path,
      message: "The endpoint is /v1/items.",
    });
    const before = yield* registry.snapshot;
    const firstRead = yield* registry.readMessages(tests.id, makeToolInvocationId("read-1"), {});
    const secondRead = yield* registry.readMessages(tests.id, makeToolInvocationId("read-2"), {});

    expect(accepted).toEqual({ to: tests.path, recipientState: "queued" });
    expect(before.agents.find(({ id }) => id === tests.id)?.hasPendingCommand).toBe(true);
    expect(firstRead).toEqual({
      items: [{ kind: "message", from: api.path, message: "The endpoint is /v1/items." }],
      inbox: { unreadMessages: 0, openRequests: 0, omittedFromPage: 0 },
    });
    expect(secondRead.items).toEqual([]);
  }),
);

it.effect("keeps a parked recipient asleep through passive coordination updates", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const recipient = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-recipient"),
      children: [{ name: makeAgentName("recipient"), goal: "work", profile }],
      wait: "none",
    })).children[0]!;
    const recipientClaim = yield* registry.takePendingCommand(recipient.id);
    yield* registry.beginRun(recipient.id, recipientClaim.token);
    const dependency = (yield* registry.registerBatch({
      parentId: recipient.id,
      invocationId: makeToolInvocationId("delegate-dependency"),
      children: [{ name: makeAgentName("dependency"), goal: "dependency", profile }],
      wait: "all",
    })).children[0]!;
    yield* registry.finishTurn({
      agentId: recipient.id,
      commandToken: recipientClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependency"),
          },
        ],
      },
    });
    const taker = yield* Effect.forkChild(registry.takePendingCommand(recipient.id));

    yield* registry.sendMessage(root.id, makeToolInvocationId("passive-message"), {
      to: recipient.path,
      message: "Passive context",
    });
    yield* registry.postBulletin(root.id, makeToolInvocationId("passive-bulletin"), {
      message: "Passive bulletin",
    });
    yield* registry.setActivity(recipient.id, makeToolInvocationId("passive-activity"), {
      activity: "still waiting",
    });
    const stillParked = yield* registry.snapshot;

    yield* registry.settle(dependency.id, completed(dependency.id));
    const resumeClaim = yield* Fiber.join(taker);
    const resumed = yield* registry.beginRun(recipient.id, resumeClaim.token);

    expect(stillParked.agents.find(({ id }) => id === recipient.id)).toMatchObject({
      status: "Waiting",
      activity: "still waiting",
      waitTargets: [dependency.id],
      hasPendingCommand: false,
    });
    expect(resumed).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        notice: { unreadMessages: 1, unseenBulletins: 1 },
      },
    });
  }),
);

it.effect("wakes a parked recipient with an operator message and reparks after handling", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const worker = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-worker"),
      children: [{ name: makeAgentName("worker"), goal: "work", profile }],
      wait: "none",
    })).children[0]!;
    const claim = yield* registry.takePendingCommand(worker.id);
    yield* registry.beginRun(worker.id, claim.token);
    const dependency = (yield* registry.registerBatch({
      parentId: worker.id,
      invocationId: makeToolInvocationId("delegate-dependency"),
      children: [{ name: makeAgentName("dependency"), goal: "dependency", profile }],
      wait: "all",
    })).children[0]!;
    yield* registry.finishTurn({
      agentId: worker.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependency"),
          },
        ],
      },
    });
    const taker = yield* Effect.forkChild(registry.takePendingCommand(worker.id));

    const delivery = yield* registry.deliverOperatorMessage(
      worker.id,
      makeOperatorMessageId("opmsg_park-steer"),
      "Focus on the API surface first.",
    );
    const wakeClaim = yield* Fiber.join(taker);
    const woken = yield* registry.beginRun(worker.id, wakeClaim.token);
    const decision = yield* registry.finishTurn({
      agentId: worker.id,
      commandToken: wakeClaim.token,
      piOutcome: {
        _tag: "Completed",
        result: { finalText: "noted", finalMessageId: undefined, stopReason: "stop" },
      },
      completedResult: result(worker.id, "noted"),
    });

    expect(delivery).toEqual({ to: worker.path, recipientState: "waiting" });
    expect(wakeClaim.trigger).toBe("coordination");
    expect(woken).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "CoordinationWake",
        operatorMessage: "Focus on the API surface first.",
        notice: { unreadMessages: 0, openRequests: 0, unseenBulletins: 0 },
      },
    });
    expect(decision).toMatchObject({ _tag: "Park", targetIds: [dependency.id] });
  }),
);

it.effect(
  "rejects operator messages to terminal or saturated recipients and keeps them out of the inbox",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
      const root = yield* registry.registerRoot({
        name: makeAgentName("root"),
        goal: "coordinate",
        profile,
      });
      const children = (yield* registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-children"),
        children: [
          { name: makeAgentName("worker"), goal: "work", profile },
          { name: makeAgentName("doomed"), goal: "die", profile },
        ],
        wait: "none",
      })).children;
      const worker = children[0]!;
      const doomed = children[1]!;

      yield* registry.settle(doomed.id, completed(doomed.id));
      const terminal = yield* Effect.flip(
        registry.deliverOperatorMessage(doomed.id, makeOperatorMessageId("opmsg_late"), "too late"),
      );

      yield* registry.sendMessage(root.id, makeToolInvocationId("peer-first"), {
        to: worker.path,
        message: "peer context",
      });
      yield* registry.deliverOperatorMessage(
        worker.id,
        makeOperatorMessageId("opmsg_direct"),
        "operator steer",
      );
      const read = yield* registry.readMessages(worker.id, makeToolInvocationId("read-mixed"), {});

      yield* Effect.forEach(
        Array.from({ length: MAX_PENDING_OPERATOR_MESSAGES_PER_AGENT - 1 }, (_, index) => index),
        (index) =>
          registry.deliverOperatorMessage(
            worker.id,
            makeOperatorMessageId(`opmsg_fill-${index}`),
            `steer ${index}`,
          ),
      );
      const overflow = yield* Effect.flip(
        registry.deliverOperatorMessage(
          worker.id,
          makeOperatorMessageId("opmsg_overflow"),
          "one too many",
        ),
      );

      expect(terminal).toMatchObject({
        _tag: "OperatorMessageRejected",
        reason: "RecipientTerminal",
      });
      // Operator messages never surface through the peer inbox.
      expect(read.items).toEqual([{ kind: "message", from: root.path, message: "peer context" }]);
      expect(overflow).toMatchObject({
        _tag: "OperatorMessageRejected",
        reason: "CapacityExceeded",
      });
    }),
);

it.effect(
  "turns an operator message racing completion into a coordination turn before settlement",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ maxAgentAdmissions: 1, ...deterministicIds() });
      const root = yield* registry.registerRoot({
        name: makeAgentName("root"),
        goal: "coordinate",
        profile,
      });
      const claim = yield* registry.takePendingCommand(root.id);
      yield* registry.beginRun(root.id, claim.token);

      yield* registry.deliverOperatorMessage(
        root.id,
        makeOperatorMessageId("opmsg_race"),
        "One more thing before you finish.",
      );
      const raced = yield* registry.finishTurn({
        agentId: root.id,
        commandToken: claim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "premature", finalMessageId: undefined, stopReason: "stop" },
        },
        completedResult: result(root.id, "premature"),
      });
      const wakeClaim = yield* registry.takePendingCommand(root.id);
      const woken = yield* registry.beginRun(root.id, wakeClaim.token);
      const final = yield* registry.finishTurn({
        agentId: root.id,
        commandToken: wakeClaim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "final", finalMessageId: undefined, stopReason: "stop" },
        },
        completedResult: result(root.id, "final"),
      });

      expect(raced).toEqual({ _tag: "RunNext" });
      expect(woken).toMatchObject({
        _tag: "Ready",
        command: {
          _tag: "CoordinationWake",
          operatorMessage: "One more thing before you finish.",
        },
      });
      expect(final).toMatchObject({
        _tag: "Settled",
        outcome: { _tag: "Completed", result: { summary: "final" } },
      });
    }),
);

it.effect("settles directly when a steered operator message was confirmed injected", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 1, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);

    yield* registry.deliverOperatorMessage(
      root.id,
      makeOperatorMessageId("opmsg_steered"),
      "Steered mid-run.",
    );
    const final = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Completed",
        result: { finalText: "done", finalMessageId: undefined, stopReason: "stop" },
        deliveredOperatorMessages: ["opmsg_steered"],
      },
      completedResult: result(root.id, "done"),
    });

    // The confirmed injection settles the message in the same transaction, so
    // no coordination turn is owed and no duplicate delivery can follow.
    expect(final).toMatchObject({
      _tag: "Settled",
      outcome: { _tag: "Completed", result: { summary: "done" } },
    });
  }),
);

it.effect("keeps output-limited passive messages pending until a later read", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("reader"), goal: "read", profile }],
      wait: "none",
    })).children[0]!;
    yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => index),
      (index) =>
        registry.sendMessage(root.id, makeToolInvocationId(`large-message-${index}`), {
          to: child.path,
          message: `${index}${"x".repeat(3_999)}`,
        }),
      { discard: true },
    );

    const first = yield* registry.readMessages(child.id, makeToolInvocationId("large-read-1"), {});
    const second = yield* registry.readMessages(child.id, makeToolInvocationId("large-read-2"), {});

    expect(Array.from(JSON.stringify(first)).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(first.items.length).toBeLessThan(8);
    expect(first.inbox.unreadMessages).toBe(8 - first.items.length);
    expect(second.items).toHaveLength(8 - first.items.length);
  }),
);

it.effect("keeps passive-message capacity local and replenishes it only by reading", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const children = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-children"),
      children: [
        { name: makeAgentName("full"), goal: "full", profile },
        { name: makeAgentName("free"), goal: "free", profile },
      ],
      wait: "none",
    })).children;
    const full = children[0]!;
    const free = children[1]!;
    yield* Effect.forEach(
      Array.from({ length: MAX_UNREAD_MESSAGES_PER_AGENT }, (_, index) => index),
      (index) =>
        registry.sendMessage(root.id, makeToolInvocationId(`fill-${index}`), {
          to: full.path,
          message: `message ${index}`,
        }),
      { discard: true },
    );

    const rejected = yield* Effect.flip(
      registry.sendMessage(root.id, makeToolInvocationId("overflow"), {
        to: full.path,
        message: "overflow",
      }),
    );
    const acceptedElsewhere = yield* registry.sendMessage(root.id, makeToolInvocationId("other"), {
      to: free.path,
      message: "independent",
    });
    yield* registry.readMessages(full.id, makeToolInvocationId("drain-one"), { limit: 1 });
    const acceptedAfterRead = yield* registry.sendMessage(
      root.id,
      makeToolInvocationId("after-read"),
      { to: full.path, message: "new slot" },
    );

    expect(rejected.reason).toBe("RecipientMessageCapacityExceeded");
    expect(rejected.message).toContain(".brood/shared/");
    expect(acceptedElsewhere.to).toBe(free.path);
    expect(acceptedAfterRead.to).toBe(full.path);
  }),
);

it.effect("keeps an addressed question visible until its exact recipient replies", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("api"), goal: "api", profile }],
      wait: "none",
    })).children[0]!;

    const asked = yield* registry.askAgent(child.id, makeToolInvocationId("ask-1"), {
      to: root.path,
      question: "Which endpoint should I implement?",
    });
    const first = yield* registry.readMessages(root.id, makeToolInvocationId("read-1"), {});
    const repeated = yield* registry.readMessages(root.id, makeToolInvocationId("read-2"), {});
    const replied = yield* registry.replyToRequest(root.id, makeToolInvocationId("reply-1"), {
      request: asked.request,
      message: "Implement /v1/items.",
    });
    const afterReply = yield* registry.readMessages(root.id, makeToolInvocationId("read-3"), {});
    const duplicate = yield* Effect.flip(
      registry.replyToRequest(root.id, makeToolInvocationId("reply-2"), {
        request: asked.request,
        message: "replace",
      }),
    );

    expect(asked).toMatchObject({
      version: 1,
      to: root.path,
      recipientState: "queued",
      broodControl: {
        version: 1,
        kind: "suspend",
        invocationId: makeToolInvocationId("ask-1"),
      },
    });
    expect(first.items).toEqual([
      {
        kind: "request",
        request: asked.request,
        from: child.path,
        question: "Which endpoint should I implement?",
      },
    ]);
    expect(repeated.items).toEqual(first.items);
    expect(replied).toEqual({ request: asked.request, to: child.path });
    expect(afterReply.inbox.openRequests).toBe(0);
    expect(duplicate.reason).toBe("AlreadyReplied");
  }),
);

it.effect("combines two asks into one source-ordered all-of continuation exactly once", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);
    const recipients = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-advisors"),
      children: [
        { name: makeAgentName("first"), goal: "first", profile },
        { name: makeAgentName("second"), goal: "second", profile },
      ],
      wait: "none",
    })).children;
    const firstRecipient = recipients[0]!;
    const secondRecipient = recipients[1]!;
    const first = yield* registry.askAgent(root.id, makeToolInvocationId("ask-first"), {
      to: firstRecipient.path,
      question: "First answer?",
    });
    const second = yield* registry.askAgent(root.id, makeToolInvocationId("ask-second"), {
      to: secondRecipient.path,
      question: "Second answer?",
    });
    const parked = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-first"),
            request: first.request,
          },
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-second"),
            request: second.request,
          },
        ],
      },
    });
    yield* registry.replyToRequest(secondRecipient.id, makeToolInvocationId("reply-second"), {
      request: second.request,
      message: "second reply",
    });
    const afterSecond = yield* registry.snapshot;
    yield* registry.replyToRequest(firstRecipient.id, makeToolInvocationId("reply-first"), {
      request: first.request,
      message: "first reply",
    });
    const resumeClaim = yield* registry.takePendingCommand(root.id);
    const resumed = yield* registry.beginRun(root.id, resumeClaim.token);
    const afterDelivery = yield* registry.snapshot;

    expect(parked).toMatchObject({
      _tag: "Park",
      targetIds: [firstRecipient.id, secondRecipient.id],
    });
    expect(afterSecond.agents.find(({ id }) => id === root.id)).toMatchObject({
      status: "Waiting",
      waitTargets: [firstRecipient.id],
    });
    expect(resumed).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        requests: [
          { _tag: "Replied", request: first.request, reply: "first reply" },
          { _tag: "Replied", request: second.request, reply: "second reply" },
        ],
      },
    });
    expect(afterDelivery.agents.find(({ id }) => id === root.id)?.waitTargets).toEqual([]);
  }),
);

it.effect("bounds each requester's complete undelivered composite wait", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const recipient = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-recipient"),
      children: [{ name: makeAgentName("recipient"), goal: "answer", profile }],
      wait: "none",
    })).children[0]!;
    yield* Effect.forEach(
      Array.from({ length: MAX_REQUEST_TARGETS_PER_WAIT }, (_, index) => index),
      (index) =>
        registry.askAgent(root.id, makeToolInvocationId(`bounded-ask-${index}`), {
          to: recipient.path,
          question: `question ${index}`,
        }),
      { discard: true },
    );

    const rejected = yield* Effect.flip(
      registry.askAgent(root.id, makeToolInvocationId("bounded-ask-overflow"), {
        to: recipient.path,
        question: "one too many",
      }),
    );

    expect(rejected.reason).toBe("RequestWaitLimitExceeded");
    expect(rejected.message).toContain("wait for them before asking another");
  }),
);

it.effect("lets a parked parent answer a child and then repark on its original wait", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const rootInitialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, rootInitialClaim.token);
    const children = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-workers"),
      children: [
        { name: makeAgentName("api"), goal: "api", profile },
        { name: makeAgentName("tests"), goal: "tests", profile },
      ],
      wait: "all",
    })).children;
    const api = children[0]!;
    const tests = children[1]!;
    expect(
      yield* registry.finishTurn({
        agentId: root.id,
        commandToken: rootInitialClaim.token,
        piOutcome: {
          _tag: "Suspended",
          markers: [
            {
              _tag: "AgentWait",
              tool: "delegate",
              invocationId: makeToolInvocationId("delegate-workers"),
            },
          ],
        },
      }),
    ).toMatchObject({ _tag: "Park" });

    const apiInitialClaim = yield* registry.takePendingCommand(api.id);
    yield* registry.beginRun(api.id, apiInitialClaim.token);
    const asked = yield* registry.askAgent(api.id, makeToolInvocationId("ask-root"), {
      to: root.path,
      question: "Should this endpoint accept PUT?",
    });
    expect(
      yield* registry.finishTurn({
        agentId: api.id,
        commandToken: apiInitialClaim.token,
        piOutcome: {
          _tag: "Suspended",
          markers: [
            {
              _tag: "RequestWait",
              tool: "ask_agent",
              invocationId: makeToolInvocationId("ask-root"),
              request: asked.request,
            },
          ],
        },
      }),
    ).toMatchObject({ _tag: "Park" });

    const coordinationClaim = yield* registry.takePendingCommand(root.id);
    const coordination = yield* registry.beginRun(root.id, coordinationClaim.token);
    expect(coordination).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "CoordinationWake",
        notice: { openRequests: 1 },
        waitingFor: { agentCompletions: 2, replies: 0 },
      },
    });
    const inbox = yield* registry.readMessages(root.id, makeToolInvocationId("read-question"), {});
    expect(inbox.items[0]).toMatchObject({ request: asked.request });
    yield* registry.replyToRequest(root.id, makeToolInvocationId("answer-api"), {
      request: asked.request,
      message: "No. Implement POST and GET only.",
    });
    expect(
      yield* registry.finishTurn({
        agentId: root.id,
        commandToken: coordinationClaim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "answered", finalMessageId: "root-2", stopReason: "stop" },
        },
        completedResult: result(root.id, "answered"),
      }),
    ).toMatchObject({ _tag: "Park" });

    const apiResumeClaim = yield* registry.takePendingCommand(api.id);
    const apiResume = yield* registry.beginRun(api.id, apiResumeClaim.token);
    expect(apiResume).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        dependencies: [],
        requests: [
          {
            _tag: "Replied",
            request: asked.request,
            to: root.path,
            reply: "No. Implement POST and GET only.",
          },
        ],
      },
    });
    const rootSnapshot = (yield* registry.snapshot).agents.find(({ id }) => id === root.id);
    expect(rootSnapshot?.status).toBe("Waiting");
    expect(rootSnapshot?.waitTargets).toEqual([api.id, tests.id]);
  }),
);

it.effect("merges a request created during coordination into the existing dependency wait", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 4, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, initialClaim.token);
    const dependency = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-dependency"),
      children: [{ name: makeAgentName("dependency"), goal: "dependency", profile }],
      wait: "all",
    })).children[0]!;
    const peers = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-peers"),
      children: [
        { name: makeAgentName("asker"), goal: "ask", profile },
        { name: makeAgentName("advisor"), goal: "advise", profile },
      ],
      wait: "none",
    })).children;
    const asker = peers[0]!;
    const advisor = peers[1]!;
    const initialPark = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependency"),
          },
        ],
      },
    });
    expect(initialPark._tag).toBe("Park");

    const incoming = yield* registry.askAgent(asker.id, makeToolInvocationId("ask-root"), {
      to: root.path,
      question: "Should I use pagination?",
    });
    const coordinationClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, coordinationClaim.token);
    yield* registry.replyToRequest(root.id, makeToolInvocationId("reply-asker"), {
      request: incoming.request,
      message: "Yes.",
    });
    const outgoing = yield* registry.askAgent(root.id, makeToolInvocationId("ask-advisor"), {
      to: advisor.path,
      question: "Which cursor format should we use?",
    });
    const compositePark = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: coordinationClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-advisor"),
            request: outgoing.request,
          },
        ],
      },
    });
    yield* registry.replyToRequest(advisor.id, makeToolInvocationId("reply-root"), {
      request: outgoing.request,
      message: "Use an opaque lexical cursor.",
    });
    expect((yield* registry.snapshot).agents.find(({ id }) => id === root.id)?.status).toBe(
      "Waiting",
    );
    yield* registry.settle(dependency.id, completed(dependency.id));
    const resumeClaim = yield* registry.takePendingCommand(root.id);
    const resumed = yield* registry.beginRun(root.id, resumeClaim.token);

    expect(compositePark).toMatchObject({
      _tag: "Park",
      targetIds: [dependency.id, advisor.id],
    });
    expect(resumed).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        dependencies: [{ agentId: dependency.id }],
        requests: [{ _tag: "Replied", request: outgoing.request, to: advisor.path }],
      },
    });
  }),
);

it.effect("preserves committed ask, reply, and settlement wakes after caller cancellation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const rootInitialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, rootInitialClaim.token);
    const asker = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-asker"),
      children: [{ name: makeAgentName("asker"), goal: "ask", profile }],
      wait: "none",
    })).children[0]!;
    const dependency = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-dependency"),
      children: [{ name: makeAgentName("dependency"), goal: "work", profile }],
      wait: "all",
    })).children[0]!;
    yield* registry.finishTurn({
      agentId: root.id,
      commandToken: rootInitialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependency"),
          },
        ],
      },
    });
    const askerInitialClaim = yield* registry.takePendingCommand(asker.id);
    yield* registry.beginRun(asker.id, askerInitialClaim.token);

    const rootCoordinationTaker = yield* Effect.forkChild(registry.takePendingCommand(root.id));
    const askedCommitted = yield* Deferred.make<RequestId>();
    const asking = yield* Effect.forkChild(
      registry
        .askAgent(asker.id, makeToolInvocationId("ask-root"), {
          to: root.path,
          question: "Can I proceed?",
        })
        .pipe(
          Effect.tap(({ request }) => Deferred.succeed(askedCommitted, request)),
          Effect.andThen(Effect.never),
        ),
    );
    const requestId = yield* Deferred.await(askedCommitted);
    yield* Fiber.interrupt(asking);
    yield* registry.finishTurn({
      agentId: asker.id,
      commandToken: askerInitialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-root"),
            request: requestId,
          },
        ],
      },
    });
    const rootCoordinationClaim = yield* Fiber.join(rootCoordinationTaker);
    const rootCoordination = yield* registry.beginRun(root.id, rootCoordinationClaim.token);

    const askerResumeTaker = yield* Effect.forkChild(registry.takePendingCommand(asker.id));
    const replyCommitted = yield* Latch.make(false);
    const replying = yield* Effect.forkChild(
      registry
        .replyToRequest(root.id, makeToolInvocationId("reply-asker"), {
          request: requestId,
          message: "Proceed.",
        })
        .pipe(
          Effect.tap(() => Latch.open(replyCommitted)),
          Effect.andThen(Effect.never),
        ),
    );
    yield* Latch.await(replyCommitted);
    yield* Fiber.interrupt(replying);
    const askerResumeClaim = yield* Fiber.join(askerResumeTaker);
    const askerResumed = yield* registry.beginRun(asker.id, askerResumeClaim.token);
    const rootParked = yield* registry.finishTurn({
      agentId: root.id,
      commandToken: rootCoordinationClaim.token,
      piOutcome: {
        _tag: "Completed",
        result: { finalText: "answered", finalMessageId: "root-2", stopReason: "stop" },
      },
      completedResult: result(root.id, "answered"),
    });

    const rootResumeTaker = yield* Effect.forkChild(registry.takePendingCommand(root.id));
    const dependencyAwaiter = yield* Effect.forkChild(registry.awaitOutcome(dependency.id));
    const settlementCommitted = yield* Latch.make(false);
    const settling = yield* Effect.forkChild(
      registry.settle(dependency.id, completed(dependency.id)).pipe(
        Effect.tap(() => Latch.open(settlementCommitted)),
        Effect.andThen(Effect.never),
      ),
    );
    yield* Latch.await(settlementCommitted);
    yield* Fiber.interrupt(settling);
    const dependencyOutcome = yield* Fiber.join(dependencyAwaiter);
    const rootResumeClaim = yield* Fiber.join(rootResumeTaker);
    const rootResumed = yield* registry.beginRun(root.id, rootResumeClaim.token);

    expect(rootCoordination).toMatchObject({
      _tag: "Ready",
      command: { _tag: "CoordinationWake", notice: { openRequests: 1 } },
    });
    expect(askerResumed).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        requests: [{ _tag: "Replied", request: requestId, reply: "Proceed." }],
      },
    });
    expect(rootParked).toMatchObject({ _tag: "Park", targetIds: [dependency.id] });
    expect(dependencyOutcome).toEqual(completed(dependency.id));
    expect(rootResumed).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        dependencies: [{ agentId: dependency.id }],
      },
    });
  }),
);

it.effect("includes questions accepted before a queued command begins in that command notice", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("api"), goal: "api", profile }],
      wait: "none",
    })).children[0]!;
    yield* registry.askAgent(child.id, makeToolInvocationId("ask-before-begin"), {
      to: root.path,
      question: "Which branch?",
    });

    const claim = yield* registry.takePendingCommand(root.id);
    const begun = yield* registry.beginRun(root.id, claim.token);

    expect(begun).toMatchObject({
      _tag: "Ready",
      command: { _tag: "InitialGoal", notice: { openRequests: 1 } },
    });
  }),
);

it.effect("turns recipient termination into one unavailable request outcome", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("api"), goal: "api", profile }],
      wait: "none",
    })).children[0]!;
    const claim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, claim.token);
    const asked = yield* registry.askAgent(root.id, makeToolInvocationId("ask-api"), {
      to: child.path,
      question: "Can you support PUT?",
    });
    yield* registry.finishTurn({
      agentId: root.id,
      commandToken: claim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "RequestWait",
            tool: "ask_agent",
            invocationId: makeToolInvocationId("ask-api"),
            request: asked.request,
          },
        ],
      },
    });
    yield* registry.settle(child.id, {
      _tag: "Interrupted",
      reason: { _tag: "OperatorRequested", source: "api" },
    });

    const resumeClaim = yield* registry.takePendingCommand(root.id);
    const resume = yield* registry.beginRun(root.id, resumeClaim.token);

    expect(resume).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        requests: [
          {
            _tag: "Unavailable",
            request: asked.request,
            to: child.path,
            recipientState: "interrupted",
          },
        ],
      },
    });
  }),
);

it.effect("removes a terminal requester's question from the recipient inbox", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("api"), goal: "api", profile }],
      wait: "none",
    })).children[0]!;
    const asked = yield* registry.askAgent(child.id, makeToolInvocationId("ask-root"), {
      to: root.path,
      question: "Will this still matter?",
    });
    yield* registry.settle(child.id, completed(child.id));

    const inbox = yield* registry.readMessages(root.id, makeToolInvocationId("read-after"), {});
    const reply = yield* Effect.flip(
      registry.replyToRequest(root.id, makeToolInvocationId("reply-after"), {
        request: asked.request,
        message: "too late",
      }),
    );

    expect(inbox.items).toEqual([]);
    expect(inbox.inbox.openRequests).toBe(0);
    expect(reply.reason).toBe("UnknownOrClosedRequest");
  }),
);

it.effect(
  "keeps a queued coordination wake durable when its requester terminates before take",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
      const root = yield* registry.registerRoot({
        name: makeAgentName("root"),
        goal: "coordinate",
        profile,
      });
      const askers = (yield* registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-askers"),
        children: [
          { name: makeAgentName("old"), goal: "old", profile },
          { name: makeAgentName("new"), goal: "new", profile },
        ],
        wait: "none",
      })).children;
      const oldAsker = askers[0]!;
      const newAsker = askers[1]!;
      yield* registry.askAgent(oldAsker.id, makeToolInvocationId("old-question"), {
        to: root.path,
        question: "Old unanswered question",
      });
      const claim = yield* registry.takePendingCommand(root.id);
      yield* registry.beginRun(root.id, claim.token);
      yield* registry.askAgent(newAsker.id, makeToolInvocationId("new-question"), {
        to: root.path,
        question: "New question that will be withdrawn",
      });

      const decision = yield* registry.finishTurn({
        agentId: root.id,
        commandToken: claim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "done", finalMessageId: "root-1", stopReason: "stop" },
        },
        completedResult: result(root.id),
      });
      expect(decision._tag).toBe("RunNext");
      yield* registry.settle(newAsker.id, completed(newAsker.id));
      const queued = yield* registry.snapshot;
      expect(queued.agents.find(({ id }) => id === root.id)?.hasPendingCommand).toBe(true);

      const coordinationClaim = yield* registry.takePendingCommand(root.id);
      const begun = yield* registry.beginRun(root.id, coordinationClaim.token);

      expect(coordinationClaim.trigger).toBe("coordination");
      expect(begun._tag).toBe("Settled");
      expect((yield* registry.snapshot).agents.find(({ id }) => id === root.id)?.status).toBe(
        "Completed",
      );
    }),
);

it.effect(
  "restores an unresolved wait when a queued coordination wake disappears before take",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
      const root = yield* registry.registerRoot({
        name: makeAgentName("root"),
        goal: "coordinate",
        profile,
      });
      const initialClaim = yield* registry.takePendingCommand(root.id);
      yield* registry.beginRun(root.id, initialClaim.token);
      const dependency = (yield* registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-dependency"),
        children: [{ name: makeAgentName("dependency"), goal: "dependency", profile }],
        wait: "all",
      })).children[0]!;
      const asker = (yield* registry.registerBatch({
        parentId: root.id,
        invocationId: makeToolInvocationId("delegate-asker"),
        children: [{ name: makeAgentName("asker"), goal: "ask", profile }],
        wait: "none",
      })).children[0]!;
      yield* registry.finishTurn({
        agentId: root.id,
        commandToken: initialClaim.token,
        piOutcome: {
          _tag: "Suspended",
          markers: [
            {
              _tag: "AgentWait",
              tool: "delegate",
              invocationId: makeToolInvocationId("delegate-dependency"),
            },
          ],
        },
      });
      yield* registry.askAgent(asker.id, makeToolInvocationId("first-question"), {
        to: root.path,
        question: "First question",
      });
      const coordinationClaim = yield* registry.takePendingCommand(root.id);
      yield* registry.beginRun(root.id, coordinationClaim.token);
      yield* registry.askAgent(asker.id, makeToolInvocationId("second-question"), {
        to: root.path,
        question: "Question that will be withdrawn",
      });
      const decision = yield* registry.finishTurn({
        agentId: root.id,
        commandToken: coordinationClaim.token,
        piOutcome: {
          _tag: "Completed",
          result: { finalText: "done", finalMessageId: "root-2", stopReason: "stop" },
        },
        completedResult: result(root.id),
      });
      yield* registry.settle(asker.id, completed(asker.id));
      const queued = yield* registry.snapshot;
      const staleClaim = yield* registry.takePendingCommand(root.id);
      const begun = yield* registry.beginRun(root.id, staleClaim.token);
      const restored = yield* registry.snapshot;

      expect(decision._tag).toBe("RunNext");
      expect(queued.agents.find(({ id }) => id === root.id)?.hasPendingCommand).toBe(true);
      expect(begun).toEqual({ _tag: "Stale", status: "Waiting" });
      expect(restored.agents.find(({ id }) => id === root.id)).toMatchObject({
        status: "Waiting",
        waitTargets: [dependency.id],
        hasPendingCommand: false,
      });
    }),
);

it.effect("combines simultaneous dependency completion and a question into one command", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 3, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const initialClaim = yield* registry.takePendingCommand(root.id);
    yield* registry.beginRun(root.id, initialClaim.token);
    const asker = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-asker"),
      children: [{ name: makeAgentName("asker"), goal: "asker", profile }],
      wait: "none",
    })).children[0]!;
    const dependency = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-dependency"),
      children: [{ name: makeAgentName("dependency"), goal: "dependency", profile }],
      wait: "all",
    })).children[0]!;
    yield* registry.finishTurn({
      agentId: root.id,
      commandToken: initialClaim.token,
      piOutcome: {
        _tag: "Suspended",
        markers: [
          {
            _tag: "AgentWait",
            tool: "delegate",
            invocationId: makeToolInvocationId("delegate-dependency"),
          },
        ],
      },
    });
    yield* registry.askAgent(asker.id, makeToolInvocationId("ask-root"), {
      to: root.path,
      question: "One clarification",
    });
    const claim = yield* registry.takePendingCommand(root.id);
    expect(claim.trigger).toBe("coordination");
    yield* registry.settle(dependency.id, completed(dependency.id));

    const begun = yield* registry.beginRun(root.id, claim.token);

    expect(begun).toMatchObject({
      _tag: "Ready",
      command: {
        _tag: "WaitSatisfied",
        notice: { openRequests: 1 },
      },
    });
    if (begun._tag === "Ready" && begun.command._tag === "WaitSatisfied") {
      expect(begun.command.dependencies.map(({ agentId }) => agentId)).toEqual([dependency.id]);
    }
  }),
);

it.effect("presents every new request before repeating earlier unanswered requests", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 10, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const askers = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-askers"),
      children: Array.from({ length: 9 }, (_, index) => ({
        name: makeAgentName(`a${index + 1}`),
        goal: `ask ${index + 1}`,
        profile,
      })),
      wait: "none",
    })).children;
    const requestIds = yield* Effect.forEach(askers, (asker, index) =>
      registry
        .askAgent(asker.id, makeToolInvocationId(`ask-${index + 1}`), {
          to: root.path,
          question: `question ${index + 1}`,
        })
        .pipe(Effect.map(({ request }) => request)),
    );

    const first = yield* registry.readMessages(root.id, makeToolInvocationId("read-1"), {});
    const second = yield* registry.readMessages(root.id, makeToolInvocationId("read-2"), {});
    const third = yield* registry.readMessages(root.id, makeToolInvocationId("read-3"), {});
    const fourth = yield* registry.readMessages(root.id, makeToolInvocationId("read-4"), {});
    const cycledRequestIds = new Set(
      [...third.items, ...fourth.items].flatMap((item) =>
        item.kind === "request" ? [item.request] : [],
      ),
    );

    expect(first.items).toHaveLength(8);
    expect(second.items[0]).toMatchObject({ kind: "request", question: "question 9" });
    expect(second.inbox.openRequests).toBe(9);
    expect(cycledRequestIds).toEqual(new Set(requestIds));
  }),
);

it.effect("retains a fair globally ordered bulletin feed across terminal authors", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const child = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-child"),
      children: [{ name: makeAgentName("research"), goal: "research", profile }],
      wait: "none",
    })).children[0]!;
    yield* registry.postBulletin(root.id, makeToolInvocationId("root-post"), {
      message: "Root retained post",
    });
    yield* Effect.forEach(
      Array.from({ length: MAX_BULLETINS_PER_AUTHOR + 1 }, (_, index) => index + 1),
      (index) =>
        registry.postBulletin(child.id, makeToolInvocationId(`child-post-${index}`), {
          message: `Research post ${index}`,
        }),
      { discard: true },
    );
    expect((yield* registry.snapshot).retainedBulletinCount).toBe(9);
    yield* registry.settle(child.id, completed(child.id));
    expect((yield* registry.snapshot).retainedBulletinCount).toBe(9);

    const first = yield* registry.readBulletins(root.id, makeToolInvocationId("read-board-1"), {});
    const second = yield* registry.readBulletins(root.id, makeToolInvocationId("read-board-2"), {});

    expect(first.posts[0]).toEqual({ author: root.path, message: "Root retained post" });
    expect(first.posts.some(({ message }) => message === "Research post 1")).toBe(false);
    expect(first.posts.map(({ message }) => message)).toEqual([
      "Root retained post",
      "Research post 2",
      "Research post 3",
      "Research post 4",
      "Research post 5",
      "Research post 6",
      "Research post 7",
      "Research post 8",
    ]);
    expect(first.posts.every(({ author }) => author === root.path || author === child.path)).toBe(
      true,
    );
    expect(first.bulletin.remaining).toBe(1);
    expect(second.posts).toEqual([{ author: child.path, message: "Research post 9" }]);
    expect(second.bulletin.remaining).toBe(0);
  }),
);

it.effect("advances the bulletin cursor only through whole output-limited posts", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ maxAgentAdmissions: 2, ...deterministicIds() });
    const root = yield* registry.registerRoot({
      name: makeAgentName("root"),
      goal: "coordinate",
      profile,
    });
    const reader = (yield* registry.registerBatch({
      parentId: root.id,
      invocationId: makeToolInvocationId("delegate-reader"),
      children: [{ name: makeAgentName("reader"), goal: "read", profile }],
      wait: "none",
    })).children[0]!;
    yield* Effect.forEach(
      Array.from({ length: MAX_BULLETINS_PER_AUTHOR }, (_, index) => index),
      (index) =>
        registry.postBulletin(root.id, makeToolInvocationId(`large-post-${index}`), {
          message: `${index}${"x".repeat(3_999)}`,
        }),
      { discard: true },
    );

    const first = yield* registry.readBulletins(
      reader.id,
      makeToolInvocationId("large-board-1"),
      {},
    );
    const second = yield* registry.readBulletins(
      reader.id,
      makeToolInvocationId("large-board-2"),
      {},
    );

    expect(Array.from(JSON.stringify(first)).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(first.posts.length).toBeLessThan(MAX_BULLETINS_PER_AUTHOR);
    expect(first.bulletin.remaining).toBe(MAX_BULLETINS_PER_AUTHOR - first.posts.length);
    expect(second.posts).toHaveLength(MAX_BULLETINS_PER_AUTHOR - first.posts.length);
  }),
);
