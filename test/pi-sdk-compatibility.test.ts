// Plain Vitest is intentional: these tests execute the pinned Pi SDK's real control loop.
import { join } from "node:path";
import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  ModelThinkingLevel,
  UserMessage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, EventStream, StringEnum } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

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
});
