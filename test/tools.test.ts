import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import {
  AgentAdmissionLimitExceeded,
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
  version: 2 as const,
  batchId: makeBatchId("batch_1"),
  agents: [
    {
      name: makeAgentName("research"),
      id: makeAgentId("agent_2"),
      profile: makeProfileName("worker"),
    },
  ],
  admissions: { limit: 8, used: 3, remaining: 5 },
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
  it("strictly prepares every control-tool input before Pi can coerce it", () => {
    const [delegate, wait] = makeAgentTools(makeAgentId("agent_1"), catalogue(), makePort());

    expect(delegate.prepareArguments).toBeTypeOf("function");
    expect(wait.prepareArguments).toBeTypeOf("function");
    expect(() => delegate.prepareArguments?.({ tasks: [{ name: "research", goal: 123 }] })).toThrow(
      "Invalid task batch",
    );
    expect(() => wait.prepareArguments?.({ children: [123] })).toThrow("Invalid agent selection");
    expect(
      delegate.prepareArguments?.({
        tasks: [{ name: " research ", goal: " investigate " }],
      }),
    ).toEqual({ tasks: [{ name: "research", goal: "investigate" }], wait: "all" });
  });

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
    expect(delegate?.description).toContain("irreversibly consumes one admission");
    expect(delegate?.description).toContain("never replenish during the run");
    expect(delegate?.description).toContain("safety ceiling, not a target");
    expect(delegate?.description).toContain(
      "Every child receives the same delegation tools and run instructions.",
    );
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
    expect(() =>
      Schema.decodeUnknownSync(DelegateToolDetails)({ ...delegateDetails, version: 1 }),
    ).toThrow("Expected 2");
    const text = (result.content[0] as { readonly text: string }).text;
    expect(text).toContain("research -> agent_2 (profile: worker)");
    expect(text).toContain("Agent admissions after this batch: 3 of 8 used; 5 remain.");
    expect(text).toContain("may decrease concurrently");
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

  it("rejects excess control-tool properties before mutation", async () => {
    const port = makePort();
    const [delegate, wait] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);

    await expect(
      delegate.execute(
        "call_1",
        {
          tasks: [{ name: "research", goal: "go", hidden: "ignored before" }],
        } as never,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Invalid task batch");
    await expect(
      wait.execute(
        "call_2",
        { children: ["research"], hidden: "ignored before" } as never,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Invalid agent selection");

    expect(port.delegate).not.toHaveBeenCalled();
    expect(port.waitForAgents).not.toHaveBeenCalled();
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

describe("admission rejection at the tool boundary", () => {
  it("surfaces the quantitative rejection message to the model", async () => {
    const port: ControlToolPort = {
      ...makePort(),
      delegate: vi.fn<ControlToolPort["delegate"]>(() =>
        Effect.fail(
          new AgentAdmissionLimitExceeded({
            requested: 3,
            capacity: { limit: 8, used: 7, remaining: 1 },
          }),
        ),
      ),
    };
    const [delegate] = makeAgentTools(makeAgentId("agent_1"), catalogue(), port);

    await expect(
      delegate!.execute(
        "call_reject",
        { tasks: [{ name: "a", goal: "work" }] },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      "Requested 3 agent admissions, but only 1 of 8 remain; no agents were created. Re-plan with at most 1 task, or continue directly.",
    );
  });
});
