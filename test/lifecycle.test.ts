import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { makeAgentId, type AgentOutcome, type DrainReport } from "../src/agent.js";
import { normalizeAgentResult } from "../src/render.js";
import { interpretRootOutcome, normalizeRunRequest, runBrood } from "../src/main.js";

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

describe("run request normalization", () => {
  it("rejects an empty normalized goal with InvalidGoal", async () => {
    const error = await Effect.runPromise(
      Effect.flip(normalizeRunRequest({ goal: " \r\n " }, 4_000)),
    );
    expect(error._tag).toBe("RootStartError");
    expect(error.reason).toBe("InvalidGoal");
  });

  it("normalizes line endings and trims while treating absent instructions as valid", async () => {
    const request = await Effect.runPromise(
      normalizeRunRequest({ goal: "build\r\nthe wiki " }, 4_000),
    );
    expect(request).toEqual({ goal: "build\nthe wiki" });
  });

  it("rejects explicitly empty instructions with InvalidInstructions", async () => {
    const error = await Effect.runPromise(
      Effect.flip(normalizeRunRequest({ goal: "go", instructions: "  \n " }, 4_000)),
    );
    expect(error.reason).toBe("InvalidInstructions");
  });

  it("counts instructions in Unicode code points and fails one over without truncation", async () => {
    const exact = await Effect.runPromise(
      normalizeRunRequest({ goal: "go", instructions: "\u{1F600}".repeat(10) }, 10),
    );
    expect(exact.instructions).toBe("\u{1F600}".repeat(10));

    const over = await Effect.runPromise(
      Effect.flip(normalizeRunRequest({ goal: "go", instructions: "\u{1F600}".repeat(11) }, 10)),
    );
    expect(over.reason).toBe("InvalidInstructions");
    expect(over.message).toContain("11 Unicode code points");
    expect(over.message).toContain("maximum is 10");
  });
});

it("no longer accepts a bare string as a programmatic run request", () => {
  // @ts-expect-error string goals were replaced by the object-shaped request
  const invalid: Parameters<typeof runBrood>[0] = "goal";
  void invalid;
  const valid: Parameters<typeof runBrood>[0] = { goal: "goal" };
  expect(valid.goal).toBe("goal");
});
