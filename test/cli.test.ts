import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  loadInstructions,
  parseCliArguments,
  parseOperatorCommand,
} from "../src/cli.js";
import { normalizeRunRequest } from "../src/main.js";
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

  it("accepts either a canonical path or ID as an interrupt reference", async () => {
    await expect(Effect.runPromise(decodeOperatorCommand("interrupt root/api"))).resolves.toEqual({
      _tag: "Interrupt",
      reference: "root/api",
    });
    await expect(Effect.runPromise(decodeOperatorCommand("interrupt agent_123"))).resolves.toEqual({
      _tag: "Interrupt",
      reference: "agent_123",
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
      reference: "agent_123",
    });
    expect(parseOperatorCommand("events off")).toEqual({ _tag: "Events", enabled: false });
  });

  it("renders compact status without identifiers or outcome text", () => {
    const status: SwarmStatus = {
      version: 2,
      state: "running",
      elapsedMillis: 2_500,
      capacity: {
        admissions: { limit: 8, used: 2, remaining: 6 },
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
    expect(rendered).toContain("Admissions 2/8 (6 remaining)");
    expect(rendered).toContain("Active runs 1/2 (1 available)");
    expect(rendered).toContain("root/vask  running  1.3s");
    expect(rendered).toContain("→ root/vask");
    expect(rendered).not.toContain("agent_123");
    expect(rendered).not.toContain("result summary");
  });

  it("renders bounded agent detail separately", () => {
    const detail: AgentDetail = {
      version: 2,
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

describe("instructions file argument", () => {
  it("parses --instructions-file and resolves its path", () => {
    const parsed = parseCliArguments([
      "--config",
      "brood.json",
      "--instructions-file",
      "charter.md",
      "--goal",
      "go",
    ]);
    expect(parsed.instructionsFile).toBe(resolve("charter.md"));
  });

  it("treats a missing --instructions-file value as a usage error", () => {
    expect(() =>
      parseCliArguments(["--config", "brood.json", "--instructions-file", "--goal", "go"]),
    ).toThrow("Missing value for --instructions-file");
  });

  it("leaves instructionsFile undefined when the option is absent", () => {
    const parsed = parseCliArguments(["--config", "brood.json", "--goal", "go"]);
    expect(parsed.instructionsFile).toBeUndefined();
  });
});

describe("instructions file loading", () => {
  it("fails a missing charter file as a CLI input error naming the path", async () => {
    const missing = join(tmpdir(), `brood-cli-missing-${process.pid}`, "absent.md");
    const error = await Effect.runPromise(Effect.flip(loadInstructions(missing)));

    expect(error._tag).toBe("CliInputError");
    expect(error.message).toContain("Unable to read instructions file");
    expect(error.message).toContain(missing);
    expect(error.message).not.toContain("    at ");
  });

  it("returns file contents verbatim so the shared gate judges emptiness and bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-cli-instructions-"));
    try {
      const path = join(directory, "charter.md");
      await writeFile(path, "  \n", "utf8");
      const contents = await Effect.runPromise(loadInstructions(path));
      // No CLI-local emptiness rule: whitespace content flows to
      // normalizeRunRequest, which rejects it as InvalidInstructions.
      expect(contents).toBe("  \n");
      const rejected = await Effect.runPromise(
        Effect.flip(normalizeRunRequest({ goal: "go", instructions: contents ?? "" }, 4_000)),
      );
      expect(rejected.reason).toBe("InvalidInstructions");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes absent instruction paths through as undefined", async () => {
    expect(await Effect.runPromise(loadInstructions(undefined))).toBeUndefined();
  });
});
