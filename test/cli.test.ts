import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  makeAgentId,
  makeAgentName,
  makeProfileName,
  UnknownAgent,
  UnknownAgentReference,
} from "../src/agent.js";
import {
  decodeOperatorCommand,
  exitCodeForSignal,
  parseCliArguments,
  parseOperatorCommand,
} from "../src/cli.js";
import {
  formatAgentDetail,
  formatSwarmStatus,
  type AgentDetail,
  type SwarmStatus,
} from "../src/status.js";

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
    expect(() => parseOperatorCommand("status --yaml")).toThrow("status [--json]");
    expect(() => parseOperatorCommand("show")).toThrow("show <agent-path-or-id>");
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
    expect(parseOperatorCommand("status")).toEqual({ _tag: "Status", format: "human" });
    expect(parseOperatorCommand("status --json")).toEqual({ _tag: "Status", format: "json" });
    expect(parseOperatorCommand("show root/vask/audit")).toEqual({
      _tag: "Show",
      reference: "root/vask/audit",
      format: "human",
    });
    expect(parseOperatorCommand("show agent_123 --json")).toEqual({
      _tag: "Show",
      reference: "agent_123",
      format: "json",
    });
    expect(parseOperatorCommand("interrupt agent_123")).toEqual({
      _tag: "Interrupt",
      agentId: "agent_123",
    });
    expect(parseOperatorCommand("events off")).toEqual({ _tag: "Events", enabled: false });
  });

  it("renders compact status without identifiers or outcome text", () => {
    const status: SwarmStatus = {
      version: 1,
      state: "running",
      elapsedMillis: 2_500,
      capacity: {
        agents: { admitted: 2, limit: 8, remaining: 6 },
        runs: { active: 1, limit: 2, available: 1 },
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
          waitTargets: ["root/vask"],
          children: [
            {
              path: "root/vask",
              name: "vask",
              state: "running",
              durationMillis: 1_250,
              waitTargets: [],
              children: [],
            },
          ],
        },
      ],
    };

    const rendered = formatSwarmStatus(status);
    expect(rendered).toContain("RUNNING  2.5s");
    expect(rendered).toContain("Agents 2/8 (6 remaining)");
    expect(rendered).toContain("root/vask  running  1.3s");
    expect(rendered).toContain("→ root/vask");
    expect(rendered).not.toContain("agent_123");
    expect(rendered).not.toContain("result summary");
  });

  it("renders bounded agent detail separately", () => {
    const detail: AgentDetail = {
      version: 1,
      path: "root",
      id: makeAgentId("agent_123"),
      name: makeAgentName("root"),
      state: "completed",
      durationMillis: 750,
      waitTargets: [],
      children: [],
      profile: {
        name: makeProfileName("worker"),
        provider: "scripted",
        model: "scripted-small",
        thinkingLevel: "off",
      },
      createdAt: 10_000,
      updatedAt: 10_750,
      terminalAt: 10_750,
      outcome: {
        _tag: "Completed",
        agentId: makeAgentId("agent_123"),
        name: makeAgentName("root"),
        result: {
          agentId: makeAgentId("agent_123"),
          sessionId: "session.jsonl",
          summary: "result summary",
          truncated: false,
          originalCharacterCount: 14,
        },
      },
    };

    const rendered = formatAgentDetail(detail);
    expect(rendered).toContain("ID agent_123");
    expect(rendered).toContain("Summary result summary");
    expect(rendered).toContain("Session session.jsonl");
  });

  it("uses conventional process exit codes for operator signals", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });

  it("gives an operator a useful error for an unknown interrupt target", () => {
    const error = new UnknownAgent({ agentId: makeAgentId("agent_typo") });
    expect(error.message).toBe("Unknown agent: agent_typo");
  });

  it("gives an operator a useful error for an unknown show target", () => {
    const error = new UnknownAgentReference({ reference: "root/typo" });
    expect(error.message).toBe("Unknown agent reference: root/typo");
  });
});
