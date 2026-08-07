import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  compileProfileCatalogue,
  makeAgentId,
  makeAgentName,
  makeBatchId,
  makeProfileName,
  makeToolInvocationId,
} from "../src/agent.js";
import { inspectControlToolResults, makePiAdapter } from "../src/pi-adapter.js";
import { compileAgentToolFactory, type ControlToolPort } from "../src/tools.js";

const agentId = makeAgentId("agent_adapter");

const toolResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "delegate",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: Date.now(),
  details: {
    version: 1,
    batchId: makeBatchId("batch_1"),
    agents: [],
    broodControl: {
      version: 1,
      kind: "suspend",
      invocationId: makeToolInvocationId("call_1"),
    },
  },
  ...overrides,
});

describe("Pi control-result inspection", () => {
  it("unions valid suspend markers from successful Brood tools", () => {
    expect(inspectControlToolResults(agentId, [toolResult()])).toEqual({ suspend: true });
  });

  it("rejects malformed details and mismatched invocation IDs without throwing", () => {
    const malformed = inspectControlToolResults(agentId, [toolResult({ details: {} })]);
    const mismatch = inspectControlToolResults(agentId, [
      toolResult({
        toolCallId: "actual",
      }),
    ]);

    expect(malformed.protocolError?._tag).toBe("PiProtocolError");
    expect(mismatch.protocolError?.message).toContain("does not match");
  });

  it("ignores failed known tools and unrelated marker-shaped results", () => {
    const unrelated = toolResult({ toolName: "read" });
    const failed = toolResult({ isError: true });
    expect(inspectControlToolResults(agentId, [unrelated, failed])).toEqual({
      suspend: false,
    });
  });

  it("opens and scopes a real offline Pi session with the exact Brood tool set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-pi-adapter-"));
    try {
      const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
      });
      const catalogue = await Effect.runPromise(
        compileProfileCatalogue(
          {
            defaultProfile: "worker",
            profiles: {
              worker: {
                description: "offline adapter test",
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                thinkingLevel: "low",
              },
            },
          },
          {
            getModel: (provider, model) => modelRuntime.getModel(provider, model),
          },
          4_000,
        ),
      );
      const port: ControlToolPort = {
        delegate: () => Effect.die("unused"),
        waitForAgents: () => Effect.die("unused"),
      };
      const tools = compileAgentToolFactory(catalogue).forCaller(agentId, port);
      const adapter = makePiAdapter({
        workspacePath: directory,
        piAgentDirectory: join(directory, "state", "pi"),
        sessionDirectory: join(directory, "state", "sessions"),
        modelRuntime,
        sessionCleanupTimeoutMillis: 1_000,
      });
      const sessionId = await Effect.runPromise(
        Effect.scoped(
          adapter
            .open({
              agentId,
              profile: catalogue.defaultProfile,
              tools,
              systemPrompt: "Brood offline adapter test",
            })
            .pipe(Effect.map((agent) => agent.sessionId)),
        ),
      );
      expect(sessionId.length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies a real scripted Pi completion at prompt settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-pi-complete-"));
    try {
      const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
      });
      const faux = fauxProvider({
        provider: "scripted-complete",
        models: [{ id: "scripted-small" }],
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey("scripted-complete", "offline-test-key");
      await modelRuntime.refresh({ allowNetwork: false, providers: ["scripted-complete"] });
      faux.setResponses([
        fauxAssistantMessage("finished", { stopReason: "stop", responseId: "response-1" }),
      ]);
      const model = modelRuntime.getModel("scripted-complete", "scripted-small")!;
      const profile = {
        public: {
          name: makeProfileName("worker"),
          provider: model.provider,
          model: model.id,
          thinkingLevel: "off" as const,
        },
        description: "worker",
        model,
      };
      const catalogue = await Effect.runPromise(
        compileProfileCatalogue(
          {
            defaultProfile: "worker",
            profiles: {
              worker: {
                description: "worker",
                provider: "scripted-complete",
                model: "scripted-small",
                thinkingLevel: "off",
              },
            },
          },
          {
            getModel: (provider, id) => modelRuntime.getModel(provider, id),
          },
          4_000,
        ),
      );
      const port: ControlToolPort = {
        delegate: () => Effect.die("unused"),
        waitForAgents: () => Effect.die("unused"),
      };
      const adapter = makePiAdapter({
        workspacePath: directory,
        piAgentDirectory: join(directory, "state", "pi"),
        sessionDirectory: join(directory, "state", "sessions"),
        modelRuntime,
        sessionCleanupTimeoutMillis: 1_000,
      });
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* adapter.open({
              agentId,
              profile,
              tools: compileAgentToolFactory(catalogue).forCaller(agentId, port),
              systemPrompt: "Brood scripted completion",
            });
            return yield* agent.run("complete");
          }),
        ),
      );
      expect(outcome).toEqual({
        _tag: "Completed",
        result: {
          finalText: "finished",
          finalMessageId: "response-1",
          stopReason: "stop",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops a real scripted Pi turn after persisted delegate results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-pi-suspend-"));
    try {
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      const faux = fauxProvider({
        provider: "scripted-suspend",
        models: [{ id: "scripted-small" }],
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey("scripted-suspend", "offline-test-key");
      await modelRuntime.refresh({ allowNetwork: false, providers: ["scripted-suspend"] });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "delegate",
            {
              tasks: [{ name: "child", goal: "work" }],
              wait: "all",
            },
            { id: "call_suspend" },
          ),
          { stopReason: "toolUse" },
        ),
      ]);
      const model = modelRuntime.getModel("scripted-suspend", "scripted-small")!;
      const profile = {
        public: {
          name: makeProfileName("worker"),
          provider: model.provider,
          model: model.id,
          thinkingLevel: "off" as const,
        },
        description: "worker",
        model,
      };
      const catalogue = await Effect.runPromise(
        compileProfileCatalogue(
          {
            defaultProfile: "worker",
            profiles: {
              worker: {
                description: "worker",
                provider: "scripted-suspend",
                model: "scripted-small",
                thinkingLevel: "off",
              },
            },
          },
          {
            getModel: (provider, id) => modelRuntime.getModel(provider, id),
          },
          4_000,
        ),
      );
      const port: ControlToolPort = {
        delegate: (_callerId, invocationId) =>
          Effect.succeed({
            version: 1,
            batchId: makeBatchId("batch_suspend"),
            agents: [
              {
                name: makeAgentName("child"),
                id: makeAgentId("agent_child"),
                profile: makeProfileName("worker"),
              },
            ],
            broodControl: { version: 1, kind: "suspend", invocationId },
          }),
        waitForAgents: () => Effect.die("unused"),
      };
      const adapter = makePiAdapter({
        workspacePath: directory,
        piAgentDirectory: join(directory, "state", "pi"),
        sessionDirectory: join(directory, "state", "sessions"),
        modelRuntime,
        sessionCleanupTimeoutMillis: 1_000,
      });
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* adapter.open({
              agentId,
              profile,
              tools: compileAgentToolFactory(catalogue).forCaller(agentId, port),
              systemPrompt: "Brood scripted suspension",
            });
            return yield* agent.run("delegate");
          }),
        ),
      );
      expect(outcome).toEqual({ _tag: "Suspended" });
      expect(faux.state.callCount).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
