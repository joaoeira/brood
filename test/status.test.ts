import { describe, expect, it } from "vitest";
import { makeAgentId, makeAgentName, makeProfileName } from "../src/agent.js";
import {
  buildAgentDetail,
  buildSwarmStatus,
  formatDuration,
  StatusInvariantDefect,
  type StatusAgentSource,
} from "../src/status.js";

const agentSource = (overrides: Partial<StatusAgentSource> = {}): StatusAgentSource => ({
  id: makeAgentId("agent_root"),
  name: makeAgentName("root"),
  profile: {
    name: makeProfileName("worker"),
    provider: "scripted",
    model: "scripted-small",
    thinkingLevel: "off",
  },
  status: "Queued",
  waitTargets: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

describe("status projections", () => {
  it("builds a bounded empty-swarm record", () => {
    expect(
      buildSwarmStatus({
        lifecycle: { state: "not_started" },
        now: 10_000,
        admissions: { limit: 8, used: 0, remaining: 8 },
        maxConcurrency: 2,
        activeRuns: 0,
        agents: [],
      }),
    ).toEqual({
      version: 1,
      state: "not_started",
      elapsedMillis: 0,
      capacity: {
        admissions: { limit: 8, used: 0, remaining: 8 },
        runs: { active: 0, limit: 2, available: 2 },
      },
      counts: {
        starting: 0,
        queued: 0,
        running: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
        interrupted: 0,
      },
      agents: [],
    });
  });

  it.each([
    [999, "999ms"],
    [1_000, "1.0s"],
    [59_900, "59.9s"],
    [60_000, "1m 00s"],
    [3_600_000, "1h 00m"],
  ])("formats %d milliseconds as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  it("fails loudly when a child precedes its parent", () => {
    const root = agentSource();
    const child = agentSource({
      id: makeAgentId("agent_child"),
      name: makeAgentName("child"),
      parentId: root.id,
    });

    expect(() =>
      buildSwarmStatus({
        lifecycle: { state: "running", startedAt: 1_000 },
        now: 2_000,
        admissions: { limit: 8, used: 0, remaining: 8 },
        maxConcurrency: 2,
        activeRuns: 0,
        agents: [child, root],
      }),
    ).toThrow(StatusInvariantDefect);
  });

  it("returns no detail for an unknown path or ID", () => {
    expect(
      buildAgentDetail({ now: 2_000, agents: [agentSource()] }, "root/missing"),
    ).toBeUndefined();
  });
});
