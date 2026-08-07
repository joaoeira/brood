import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeAgentId, UnknownAgent } from "../src/agent.js";
import {
  decodeOperatorCommand,
  exitCodeForSignal,
  parseCliArguments,
  parseOperatorCommand,
} from "../src/cli.js";

describe("CLI boundaries", () => {
  it("parses a config path, positional goal, and event flag", () => {
    expect(
      parseCliArguments(["--config", "brood.json", "--events", "do", "the work"]),
    ).toMatchObject({
      configPath: expect.stringContaining("brood.json"),
      goal: "do the work",
      showEvents: true,
    });
  });

  it("rejects missing CLI inputs and malformed operator commands", () => {
    expect(() => parseCliArguments(["--config", "brood.json"])).toThrow("Missing goal");
    expect(() => parseCliArguments(["--config", "--events", "goal"])).toThrow(
      "Missing value for --config",
    );
    expect(() => parseOperatorCommand("events maybe")).toThrow("events on|off");
  });

  it("decodes operator-entered agent IDs at the Effect boundary", async () => {
    await expect(
      Effect.runPromise(decodeOperatorCommand("interrupt not-an-agent")),
    ).rejects.toThrow("Invalid agent ID");
    await expect(Effect.runPromise(decodeOperatorCommand("interrupt agent_123"))).resolves.toEqual({
      _tag: "Interrupt",
      agentId: "agent_123",
    });
  });

  it("parses the complete v1 operator command surface", () => {
    expect(parseOperatorCommand("status")).toEqual({ _tag: "Status" });
    expect(parseOperatorCommand("interrupt agent_123")).toEqual({
      _tag: "Interrupt",
      agentId: "agent_123",
    });
    expect(parseOperatorCommand("events off")).toEqual({ _tag: "Events", enabled: false });
  });

  it("uses conventional process exit codes for operator signals", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });

  it("gives an operator a useful error for an unknown interrupt target", () => {
    const error = new UnknownAgent({ agentId: makeAgentId("agent_typo") });
    expect(error.message).toBe("Unknown agent: agent_typo");
  });
});
