import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { makeAgentId, type AgentOutcome, type DrainReport } from "../src/agent.js";
import { normalizeAgentResult } from "../src/render.js";
import { interpretRootOutcome } from "../src/main.js";

const drain: DrainReport = {
  timedOut: false,
  interruptedAgentIds: [],
  terminalAgentCount: 1,
};

describe("root outcome interpretation", () => {
  it("preserves a successful root result with its drain report", async () => {
    const root = normalizeAgentResult(makeAgentId("agent_root"), "session", "done", 1_000);
    await expect(
      Effect.runPromise(interpretRootOutcome({ _tag: "Completed", result: root }, drain)),
    ).resolves.toEqual({ root, drain });
  });

  it("keeps failure and operator interruption distinct after drain", async () => {
    const failed: AgentOutcome = {
      _tag: "Failed",
      failure: { _tag: "AgentDefect", cause: Cause.die("boom") },
    };
    const interrupted: AgentOutcome = {
      _tag: "Interrupted",
      reason: { _tag: "OperatorRequested", source: "api" },
    };
    const failedExit = await Effect.runPromiseExit(interpretRootOutcome(failed, drain));
    const interruptedExit = await Effect.runPromiseExit(interpretRootOutcome(interrupted, drain));

    expect(Exit.isFailure(failedExit)).toBe(true);
    if (Exit.isSuccess(failedExit)) throw new Error("Expected failed root outcome");
    expect(Cause.findErrorOption(failedExit.cause)).toMatchObject({
      value: {
        _tag: "AgentFailed",
        failure: {
          code: "AgentDefect",
          message: expect.not.stringContaining("boom"),
        },
        drain,
      },
    });
    expect(Exit.isFailure(interruptedExit)).toBe(true);
    if (Exit.isSuccess(interruptedExit)) throw new Error("Expected interrupted root outcome");
    expect(Cause.findErrorOption(interruptedExit.cause)).toMatchObject({
      value: {
        _tag: "RootInterrupted",
        reason: { _tag: "OperatorRequested", source: "api" },
        drain,
      },
    });
  });
});
