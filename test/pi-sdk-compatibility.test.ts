// Plain Vitest is intentional: these tests execute the pinned Pi SDK's real control loop.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  ModelThinkingLevel,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  EventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  StringEnum,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { makeAgentId } from "../src/agent.js";
import {
  MAX_BULLETIN_CHARS,
  MAX_REPLY_CHARS,
  type CommunicationToolPort,
} from "../src/communication.js";
import { makeCommunicationTools } from "../src/communication-tools.js";

const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ModelThinkingLevel>;

const exhaustiveThinkingLevels: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected stream event");
      },
    );
  }
}

const createUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const createModel = (): Model<"openai-responses"> => ({
  id: "scripted-small",
  name: "Scripted Small",
  api: "openai-responses",
  provider: "scripted",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 2_048,
});

const createAssistantMessage = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "scripted",
  model: "scripted-small",
  usage: createUsage(),
  stopReason,
  timestamp: Date.now(),
});

const createUserMessage = (content: string): UserMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

const identityConverter = (messages: AgentMessage[]): Message[] =>
  messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  ) as Message[];

class CompatibilityToolRejected extends Schema.TaggedError<CompatibilityToolRejected>()(
  "CompatibilityToolRejected",
  { message: Schema.String },
) {}

describe("pinned Pi SDK compatibility", () => {
  it("constructs a provider-safe runtime profile enum", () => {
    const profileNames: ReadonlyArray<string> = ["worker", "researcher"];
    const schema = StringEnum(profileNames);

    expect(Reflect.get(schema, "enum")).toEqual(["worker", "researcher"]);
  });

  it("keeps Brood's thinking levels exhaustive with Pi", () => {
    expect(Object.keys(exhaustiveThinkingLevels)).toEqual(thinkingLevels);
  });

  it("documents that Pi does not deduplicate a toolCallId reused across turns", async () => {
    const parameters = Type.Object({ value: Type.String() });
    const executions: string[] = [];
    const tool: AgentTool<typeof parameters, { value: string }> = {
      name: "control",
      label: "Control",
      description: "Record executions",
      parameters,
      execute: async (_toolCallId, input) => {
        executions.push(input.value);
        return {
          content: [{ type: "text", text: input.value }],
          details: { value: input.value },
        };
      },
    };
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [tool],
    };
    let request = 0;
    const stream = agentLoop(
      [createUserMessage("run")],
      context,
      { model: createModel(), convertToLlm: identityConverter },
      undefined,
      () => {
        const response = new MockAssistantStream();
        const currentRequest = request++;
        queueMicrotask(() => {
          const message =
            currentRequest < 2
              ? createAssistantMessage(
                  [
                    {
                      type: "toolCall",
                      id: "reused-id",
                      name: "control",
                      arguments: { value: currentRequest === 0 ? "first" : "second" },
                    },
                  ],
                  "toolUse",
                )
              : createAssistantMessage([{ type: "text", text: "done" }]);
          response.push({
            type: "done",
            reason: currentRequest < 2 ? "toolUse" : "stop",
            message,
          });
        });
        return response;
      },
    );

    await stream.result();

    expect(executions).toEqual(["first", "second"]);
  });

  it("returns ordinary parallel-tool results in assistant source order", async () => {
    const parameters = Type.Object({});
    let releaseFirst = (): void => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first: AgentTool<typeof parameters, { value: string }> = {
      name: "first",
      label: "First",
      description: "Completes after second",
      parameters,
      execute: async () => {
        await firstMayFinish;
        return {
          content: [{ type: "text", text: "first result" }],
          details: { value: "first" },
        };
      },
    };
    const second: AgentTool<typeof parameters, { value: string }> = {
      name: "second",
      label: "Second",
      description: "Completes first",
      parameters,
      execute: async () => {
        releaseFirst();
        return {
          content: [{ type: "text", text: "second result" }],
          details: { value: "second" },
        };
      },
    };
    const context: AgentContext = { systemPrompt: "", messages: [], tools: [first, second] };
    let observedResults: ReadonlyArray<ToolResultMessage> = [];
    const stream = agentLoop(
      [createUserMessage("run both")],
      context,
      {
        model: createModel(),
        convertToLlm: identityConverter,
        shouldStopAfterTurn: ({ toolResults }) => {
          observedResults = toolResults;
          return true;
        },
      },
      undefined,
      () => {
        const response = new MockAssistantStream();
        queueMicrotask(() => {
          const message = createAssistantMessage(
            [
              { type: "toolCall", id: "first-call", name: "first", arguments: {} },
              { type: "toolCall", id: "second-call", name: "second", arguments: {} },
            ],
            "toolUse",
          );
          response.push({ type: "done", reason: "toolUse", message });
        });
        return response;
      },
    );

    await stream.result();

    expect(observedResults.map(({ toolCallId }) => toolCallId)).toEqual([
      "first-call",
      "second-call",
    ]);
    expect(observedResults.map(({ details }) => details)).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
  });

  it("turns a thrown typed tool error into its complete message and empty details", async () => {
    const parameters = Type.Object({});
    const tool: AgentTool<typeof parameters, Record<never, never>> = {
      name: "reject",
      label: "Reject",
      description: "Throws a typed error",
      parameters,
      execute: async () => {
        throw new CompatibilityToolRejected({
          message: "The requested peer is terminal; choose an addressable peer and retry.",
        });
      },
    };
    const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
    let observedResult: ToolResultMessage | undefined;
    const stream = agentLoop(
      [createUserMessage("reject")],
      context,
      {
        model: createModel(),
        convertToLlm: identityConverter,
        shouldStopAfterTurn: ({ toolResults }) => {
          observedResult = toolResults[0];
          return true;
        },
      },
      undefined,
      () => {
        const response = new MockAssistantStream();
        queueMicrotask(() => {
          const message = createAssistantMessage(
            [{ type: "toolCall", id: "reject-call", name: "reject", arguments: {} }],
            "toolUse",
          );
          response.push({ type: "done", reason: "toolUse", message });
        });
        return response;
      },
    );

    await stream.result();

    expect(observedResult).toMatchObject({
      toolCallId: "reject-call",
      toolName: "reject",
      isError: true,
      content: [
        {
          type: "text",
          text: "The requested peer is terminal; choose an addressable peer and retry.",
        },
      ],
      details: {},
    });
  });

  it("runs Brood preparation before Pi coercion and preserves actionable errors", async () => {
    let portInvocations = 0;
    const unreachable = () => {
      portInvocations += 1;
      return Effect.die("invalid raw input reached the communication port");
    };
    const port: CommunicationToolPort = {
      listAgents: unreachable,
      setActivity: unreachable,
      sendMessage: unreachable,
      askAgent: unreachable,
      readMessages: unreachable,
      replyToRequest: unreachable,
      postBulletin: unreachable,
      readBulletins: unreachable,
    };
    const definitions = makeCommunicationTools(makeAgentId("agent_compat"), port);
    const tools = definitions.map((definition): AgentTool => {
      const prepareArguments = definition.prepareArguments;
      if (prepareArguments === undefined) {
        throw new Error(`Missing argument preparer for ${definition.name}`);
      }
      return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        prepareArguments,
        execute: (toolCallId, params, signal, onUpdate) =>
          definition.execute(toolCallId, params, signal, onUpdate, {} as never),
      };
    });
    const context: AgentContext = { systemPrompt: "", messages: [], tools };
    let observedResults: ReadonlyArray<ToolResultMessage> = [];
    const stream = agentLoop(
      [createUserMessage("reject invalid raw inputs")],
      context,
      {
        model: createModel(),
        convertToLlm: identityConverter,
        shouldStopAfterTurn: ({ toolResults }) => {
          observedResults = toolResults;
          return true;
        },
      },
      undefined,
      () => {
        const response = new MockAssistantStream();
        queueMicrotask(() => {
          const message = createAssistantMessage(
            [
              {
                type: "toolCall",
                id: "invalid-message",
                name: "send_message",
                arguments: { to: "root/peer", message: 123 },
              },
              {
                type: "toolCall",
                id: "invalid-limit",
                name: "read_messages",
                arguments: { limit: "8" },
              },
              {
                type: "toolCall",
                id: "oversize-reply",
                name: "reply_to_request",
                arguments: {
                  request: "request_1",
                  message: "😀".repeat(MAX_REPLY_CHARS + 1),
                },
              },
              {
                type: "toolCall",
                id: "oversize-bulletin",
                name: "post_bulletin",
                arguments: { message: "b".repeat(MAX_BULLETIN_CHARS + 1) },
              },
            ],
            "toolUse",
          );
          response.push({ type: "done", reason: "toolUse", message });
        });
        return response;
      },
    );

    await stream.result();

    expect(portInvocations).toBe(0);
    expect(observedResults).toHaveLength(4);
    expect(observedResults.every(({ isError }) => isError)).toBe(true);
    expect(observedResults[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Invalid send_message input"),
    });
    expect(observedResults[1]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Invalid read_messages limit"),
    });
    expect(observedResults[2]?.content[0]).toEqual({
      type: "text",
      text: `The reply contains ${MAX_REPLY_CHARS + 1} Unicode code points; the maximum is ${MAX_REPLY_CHARS}. Put the full answer under \`.brood/shared/\` and reply with a summary and path.`,
    });
    expect(observedResults[3]?.content[0]).toEqual({
      type: "text",
      text: `The bulletin contains ${MAX_BULLETIN_CHARS + 1} Unicode code points; the maximum is ${MAX_BULLETIN_CHARS}. Put the full material under \`.brood/shared/\` and post a short description with its path.`,
    });
  });

  it("does not poll steering again after shouldStopAfterTurn accepts a tool turn", async () => {
    const parameters = Type.Object({});
    const tool: AgentTool<typeof parameters, Record<never, never>> = {
      name: "stop",
      label: "Stop",
      description: "Produces a stopping tool result",
      parameters,
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
    let steeringPolls = 0;
    const stream = agentLoop(
      [createUserMessage("stop")],
      context,
      {
        model: createModel(),
        convertToLlm: identityConverter,
        getSteeringMessages: async () => {
          steeringPolls += 1;
          return [];
        },
        shouldStopAfterTurn: () => true,
      },
      undefined,
      () => {
        const response = new MockAssistantStream();
        queueMicrotask(() => {
          const message = createAssistantMessage(
            [{ type: "toolCall", id: "stop-call", name: "stop", arguments: {} }],
            "toolUse",
          );
          response.push({ type: "done", reason: "toolUse", message });
        });
        return response;
      },
    );

    await stream.result();

    expect(steeringPolls).toBe(1);
  });

  it("accepts the model, thinking, tools, hook, and cleanup surfaces Brood needs", async () => {
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");

    expect(model).toBeDefined();
    if (!model) return;

    const delegate = defineTool({
      name: "delegate",
      label: "Delegate",
      description: "Compatibility spike",
      parameters: Type.Object({
        profile: Type.Optional(StringEnum(["worker"])),
      }),
      execute: async (_toolCallId, input) => ({
        content: [{ type: "text", text: input.profile ?? "worker" }],
        details: {},
      }),
    });
    const cwd = process.cwd();
    const agentDir = join(cwd, ".test-pi-agent");
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd,
      settingsManager,
      systemPromptOverride: () => "Brood compatibility spike",
    });
    await resourceLoader.reload();

    const { session, modelFallbackMessage } = await createAgentSession({
      agentDir,
      cwd,
      modelRuntime,
      model,
      thinkingLevel: clampThinkingLevel(model, "high"),
      customTools: [delegate],
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    session.agent.shouldStopAfterTurn = async ({ toolResults }) => toolResults.length > 0;

    expect(modelFallbackMessage).toBeUndefined();
    expect(session.model?.provider).toBe(model.provider);
    expect(session.model?.id).toBe(model.id);
    expect(session.getActiveToolNames()).toContain("delegate");

    await session.abort();
    session.dispose();
  });

  it("persists successful tool details before shouldStopAfterTurn runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-pi-compat-persistence-"));
    try {
      const faux = fauxProvider({
        provider: "compat-persistence",
        models: [{ id: "scripted-small" }],
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("persist", {}, { id: "persist-call" }), {
          stopReason: "toolUse",
        }),
      ]);
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey("compat-persistence", "offline-test-key");
      await modelRuntime.refresh({ allowNetwork: false, providers: ["compat-persistence"] });
      const model = modelRuntime.getModel("compat-persistence", "scripted-small");
      expect(model).toBeDefined();
      if (model === undefined) return;

      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: join(directory, "agent"),
        settingsManager,
        noExtensions: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => "Compatibility persistence test",
      });
      await resourceLoader.reload();
      const tool = defineTool({
        name: "persist",
        label: "Persist",
        description: "Return machine-readable details",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => ({
          content: [{ type: "text" as const, text: "persisted" }],
          details: { kind: "marker", request: "request_compat" },
        }),
      });
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: join(directory, "agent"),
        modelRuntime,
        model,
        thinkingLevel: "off",
        customTools: [tool],
        resourceLoader,
        sessionManager: SessionManager.create(directory, join(directory, "sessions")),
        settingsManager,
      });
      try {
        let stateContainedResult = false;
        let persistedContainedResult = false;
        session.agent.shouldStopAfterTurn = async ({ context, toolResults }) => {
          stateContainedResult =
            toolResults.some(
              (result) =>
                result.toolCallId === "persist-call" &&
                typeof result.details === "object" &&
                result.details !== null &&
                Reflect.get(result.details, "request") === "request_compat",
            ) &&
            context.messages.some(
              (message) => message.role === "toolResult" && message.toolCallId === "persist-call",
            ) &&
            session.messages.some(
              (message) => message.role === "toolResult" && message.toolCallId === "persist-call",
            );
          const sessionFile = session.sessionFile;
          if (sessionFile !== undefined) {
            const persisted = await readFile(sessionFile, "utf8");
            persistedContainedResult =
              persisted.includes('"toolCallId":"persist-call"') &&
              persisted.includes('"request":"request_compat"');
          }
          return true;
        };

        await session.prompt("persist details", {
          expandPromptTemplates: false,
          source: "extension",
        });

        expect(stateContainedResult).toBe(true);
        expect(persistedContainedResult).toBe(true);
      } finally {
        await session.abort();
        session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
