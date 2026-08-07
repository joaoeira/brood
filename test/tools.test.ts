import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import {
  DelegateToolDetails,
  WaitToolDetails,
  makeAgentId,
  makeAgentName,
  makeBatchId,
  makeProfileName,
  makeToolInvocationId,
} from "../src/agent.js";
import { makeAgentTools, type ControlToolPort } from "../src/tools.js";
import { compileProfileCatalogue } from "../src/profiles.js";
import { normalizeAgentResult } from "../src/render.js";
import { testModelLookup, testProfile, testProfilesConfig } from "./support/profiles.js";

const catalogue = () =>
  Effect.runSync(
    compileProfileCatalogue(
      testProfilesConfig({
        profiles: {
          worker: testProfile({ description: "general work" }),
          coordinator: testProfile({ description: "coordination" }),
        },
      }),
      testModelLookup(),
      4_000,
    ),
  );

const delegateDetails = {
  version: 1 as const,
  batchId: makeBatchId("batch_1"),
  agents: [
    {
      name: makeAgentName("research"),
      id: makeAgentId("agent_2"),
      profile: makeProfileName("worker"),
    },
  ],
  broodControl: {
    version: 1 as const,
    kind: "suspend" as const,
    invocationId: makeToolInvocationId("call_1"),
  },
};

const makePort = (): ControlToolPort => ({
  delegate: vi.fn<ControlToolPort["delegate"]>(() => Effect.succeed(delegateDetails)),
  waitForAgents: vi.fn<ControlToolPort["waitForAgents"]>((_callerId, invocationId) =>
    Effect.succeed({
      version: 1 as const,
      outcomes: [
        {
          _tag: "Completed" as const,
          agentId: makeAgentId("agent_first"),
          name: makeAgentName("first"),
          result: normalizeAgentResult(
            makeAgentId("agent_first"),
            "session-first",
            "finished",
            1_000,
          ),
        },
        {
          _tag: "Completed" as const,
          agentId: makeAgentId("agent_second"),
          name: makeAgentName("second"),
          result: normalizeAgentResult(
            makeAgentId("agent_second"),
            "session-second",
            "finished too",
            1_000,
          ),
        },
      ],
      broodControl: { version: 1 as const, kind: "continue" as const, invocationId },
    }),
  ),
});

describe("Brood tools", () => {
  it("builds one delegate profile enum from the sorted run catalogue", () => {
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), makePort());
    expect(delegate?.name).toBe("delegate");
    const properties = Reflect.get(delegate!.parameters, "properties") as object;
    const tasks = Reflect.get(properties, "tasks") as object;
    const items = Reflect.get(tasks, "items") as object;
    const taskProperties = Reflect.get(items, "properties") as object;
    const profile = Reflect.get(taskProperties, "profile") as object;
    expect(Reflect.get(profile, "enum")).toEqual(["coordinator", "worker"]);
    expect(Reflect.has(profile, "allOf")).toBe(false);
    expect(delegate?.description).toContain("Default profile: worker");
    expect(delegate?.executionMode).toBe("sequential");
  });

  it("normalizes a whole delegate batch and defaults wait to all", async () => {
    const port = makePort();
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    const result = await delegate!.execute(
      "call_1",
      { tasks: [{ name: " research ", goal: " investigate " }] },
      undefined,
      undefined,
      {} as never,
    );

    expect(port.delegate).toHaveBeenCalledWith(
      makeAgentId("agent_1"),
      makeToolInvocationId("call_1"),
      [{ name: makeAgentName("research"), goal: "investigate" }],
      "all",
    );
    expect(Schema.decodeUnknownSync(DelegateToolDetails)(result.details)).toEqual(delegateDetails);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("research -> agent_2 (profile: worker)") },
    ]);
  });

  it("rejects duplicate normalized names before calling the port", async () => {
    const port = makePort();
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    await expect(
      delegate!.execute(
        "call_1",
        {
          tasks: [
            { name: "same", goal: "one" },
            { name: " same ", goal: "two" },
          ],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Duplicate task name");
    expect(port.delegate).not.toHaveBeenCalled();
  });

  it("rejects a profile outside the frozen catalogue before mutation", async () => {
    const port = makePort();
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    await expect(
      delegate!.execute(
        "call_1",
        { tasks: [{ name: "research", goal: "go", profile: "unknown" }] },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Unknown profile");
    expect(port.delegate).not.toHaveBeenCalled();
  });

  it("rejects a runtime-invalid wait enum before mutation", async () => {
    const port = makePort();
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    await expect(
      delegate.execute(
        "call_1",
        { tasks: [{ name: "research", goal: "go" }], wait: "sometimes" as "all" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('Expected "all" | "none"');
    expect(port.delegate).not.toHaveBeenCalled();
  });

  it("validates all wait names and renders terminal outcomes from details", async () => {
    const port = makePort();
    const [, wait] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    const result = await wait!.execute(
      "call_wait",
      { children: [" first ", "second"] },
      undefined,
      undefined,
      {} as never,
    );

    expect(port.waitForAgents).toHaveBeenCalledWith(
      makeAgentId("agent_1"),
      makeToolInvocationId("call_wait"),
      [makeAgentName("first"), makeAgentName("second")],
    );
    expect(Schema.decodeUnknownSync(WaitToolDetails)(result.details).broodControl.kind).toBe(
      "continue",
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("first (agent_first) completed: finished"),
    });
  });

  it("describes a suspended wait without claiming children are terminal", async () => {
    const port: ControlToolPort = {
      ...makePort(),
      waitForAgents: vi.fn<ControlToolPort["waitForAgents"]>((_callerId, invocationId) =>
        Effect.succeed({
          version: 1 as const,
          outcomes: [],
          broodControl: { version: 1 as const, kind: "suspend" as const, invocationId },
        }),
      ),
    };
    const [, wait] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);
    const result = await wait.execute(
      "call_wait",
      { children: ["first"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("while waiting for: first"),
    });
  });
});
