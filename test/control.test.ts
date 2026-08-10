import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { makeToolInvocationId, makeWaitId } from "../src/agent.js";
import { AgentCommand, decodeSuspensionMarker, type PiRunOutcome } from "../src/control.js";
import { makeAgentPath, makeRequestId } from "../src/communication.js";

describe("control vocabulary", () => {
  it.effect("decodes an exact request-wait marker", () =>
    Effect.gen(function* () {
      const marker = yield* decodeSuspensionMarker({
        _tag: "RequestWait",
        tool: "ask_agent",
        invocationId: makeToolInvocationId("call_1"),
        request: makeRequestId("request_1"),
      });

      expect(marker._tag).toBe("RequestWait");
      if (marker._tag !== "RequestWait") {
        throw new Error("expected a request wait marker");
      }
      expect(marker.request).toBe("request_1");
    }),
  );

  it.effect("rejects excess marker properties at the Pi boundary", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeSuspensionMarker({
          _tag: "AgentWait",
          tool: "delegate",
          invocationId: makeToolInvocationId("call_1"),
          injected: true,
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it("represents a suspended Pi run with its complete ordered marker set", () => {
    const outcome: PiRunOutcome = {
      _tag: "Suspended",
      markers: [
        {
          _tag: "RequestWait",
          tool: "ask_agent",
          invocationId: makeToolInvocationId("call_1"),
          request: makeRequestId("request_1"),
        },
        {
          _tag: "AgentWait",
          tool: "wait_for_agents",
          invocationId: makeToolInvocationId("call_2"),
        },
      ],
    };

    expect(outcome.markers.map((marker) => marker.invocationId)).toEqual(["call_1", "call_2"]);
  });

  it.effect("round-trips the bounded coordination command variants", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: "error" });
      const command = yield* decode({
        _tag: "CoordinationWake",
        notice: { unreadMessages: 2, openRequests: 1, unseenBulletins: 3 },
        waitingFor: { agentCompletions: 2, replies: 1 },
      });

      if (command._tag !== "CoordinationWake") {
        throw new Error("expected a coordination wake command");
      }
      expect(command.waitingFor).toEqual({ agentCompletions: 2, replies: 1 });

      const resumed = yield* decode({
        _tag: "WaitSatisfied",
        waitId: makeWaitId("wait_1"),
        dependencies: [],
        requests: [
          {
            _tag: "Replied",
            request: makeRequestId("request_1"),
            to: makeAgentPath("root/api"),
            reply: "Use the shared result.",
          },
        ],
        notice: { unreadMessages: 0, openRequests: 0, unseenBulletins: 0 },
      });

      expect(resumed._tag).toBe("WaitSatisfied");
    }),
  );
});
