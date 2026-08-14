// Plain Vitest is intentional: these tests open real offline Pi sessions and session files.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  makeAgentId,
  makeAgentName,
  makeBatchId,
  makeProfileName,
  makeToolInvocationId,
} from "../src/agent.js";
import { makeAgentPath, makeRequestId } from "../src/communication.js";
import { makeCommunicationTools, type CommunicationToolPort } from "../src/communication-tools.js";
import { compileProfileCatalogue, type ProfileCatalogue } from "../src/profiles.js";
import {
  findLatestSessionFile,
  inspectControlToolResults,
  makePiAdapter,
  repairDanglingToolCalls,
  type PiAdapter,
} from "../src/pi-adapter.js";
import { compileAgentToolFactory, type ControlToolPort } from "../src/tools.js";

const agentId = makeAgentId("agent_adapter");

const unusedPort: ControlToolPort = {
  delegate: () => Effect.die("unused"),
  waitForAgents: () => Effect.die("unused"),
};

const unusedCommunicationPort: CommunicationToolPort = {
  listAgents: () => Effect.die("unused"),
  setActivity: () => Effect.die("unused"),
  sendMessage: () => Effect.die("unused"),
  askAgent: () => Effect.die("unused"),
  readMessages: () => Effect.die("unused"),
  replyToRequest: () => Effect.die("unused"),
  postBulletin: () => Effect.die("unused"),
  readBulletins: () => Effect.die("unused"),
};

interface OfflinePiOptions {
  readonly prefix: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly thinkingLevel: "off" | "low";
  readonly provider?: ReturnType<typeof fauxProvider>;
}

interface OfflinePiContext {
  readonly directory: string;
  readonly modelRuntime: ModelRuntime;
  readonly catalogue: ProfileCatalogue;
  readonly adapter: PiAdapter;
}

const withOfflinePiAdapter = async <A>(
  options: OfflinePiOptions,
  use: (context: OfflinePiContext) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), options.prefix));
  try {
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    if (options.provider !== undefined) {
      modelRuntime.registerNativeProvider(options.provider.provider);
      await modelRuntime.setRuntimeApiKey(options.providerName, "offline-test-key");
      await modelRuntime.refresh({ allowNetwork: false, providers: [options.providerName] });
    }
    const catalogue = await Effect.runPromise(
      compileProfileCatalogue(
        {
          defaultProfile: "worker",
          profiles: {
            worker: {
              description: "offline adapter worker",
              provider: options.providerName,
              model: options.modelId,
              thinkingLevel: options.thinkingLevel,
            },
          },
        },
        { getModel: (provider, model) => modelRuntime.getModel(provider, model) },
        4_000,
      ),
    );
    const adapter = makePiAdapter({
      workspacePath: directory,
      piAgentDirectory: join(directory, "state", "pi"),
      sessionDirectory: join(directory, "state", "sessions"),
      modelRuntime,
      sessionCleanupTimeoutMillis: 1_000,
    });
    return await use({ directory, modelRuntime, catalogue, adapter });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const toolResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "delegate",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: Date.now(),
  details: {
    version: 2,
    batchId: makeBatchId("batch_1"),
    agents: [],
    admissions: { limit: 8, used: 1, remaining: 7 },
    broodControl: {
      version: 1,
      kind: "suspend",
      invocationId: makeToolInvocationId("call_1"),
    },
  },
  ...overrides,
});

const askToolResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call_ask",
  toolName: "ask_agent",
  content: [{ type: "text", text: "asked" }],
  isError: false,
  timestamp: Date.now(),
  details: {
    version: 1,
    request: makeRequestId("request_ask"),
    to: makeAgentPath("root/peer"),
    recipientState: "waiting",
    broodControl: {
      version: 1,
      kind: "suspend",
      invocationId: makeToolInvocationId("call_ask"),
    },
  },
  ...overrides,
});

const waitToolResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call_wait",
  toolName: "wait_for_agents",
  content: [{ type: "text", text: "waiting" }],
  isError: false,
  timestamp: Date.now(),
  details: {
    version: 1,
    outcomes: [],
    broodControl: {
      version: 1,
      kind: "suspend",
      invocationId: makeToolInvocationId("call_wait"),
    },
  },
  ...overrides,
});

describe("Pi control-result inspection", () => {
  it("returns every exact suspension marker in assistant source order", () => {
    expect(
      inspectControlToolResults(agentId, [
        toolResult(),
        askToolResult(),
        waitToolResult(),
        toolResult({
          toolCallId: "call_continue",
          details: {
            version: 2,
            batchId: makeBatchId("batch_continue"),
            agents: [],
            admissions: { limit: 8, used: 1, remaining: 7 },
            broodControl: {
              version: 1,
              kind: "continue",
              invocationId: makeToolInvocationId("call_continue"),
            },
          },
        }),
      ]),
    ).toEqual({
      _tag: "Suspend",
      markers: [
        {
          _tag: "AgentWait",
          tool: "delegate",
          invocationId: "call_1",
        },
        {
          _tag: "RequestWait",
          tool: "ask_agent",
          invocationId: "call_ask",
          request: "request_ask",
        },
        {
          _tag: "AgentWait",
          tool: "wait_for_agents",
          invocationId: "call_wait",
        },
      ],
    });
  });

  it("rejects missing, extra, and mismatched marker data without throwing", () => {
    const malformed = inspectControlToolResults(agentId, [toolResult({ details: {} })]);
    const extra = inspectControlToolResults(agentId, [
      toolResult({
        details: {
          version: 2,
          batchId: makeBatchId("batch_1"),
          agents: [],
          admissions: { limit: 8, used: 1, remaining: 7 },
          broodControl: {
            version: 1,
            kind: "suspend",
            invocationId: makeToolInvocationId("call_1"),
          },
          unexpected: true,
        },
      }),
    ]);
    const mismatch = inspectControlToolResults(agentId, [
      toolResult({
        toolCallId: "actual",
      }),
    ]);
    const malformedRequest = inspectControlToolResults(agentId, [
      askToolResult({
        details: {
          version: 1,
          request: "not-a-request-id",
          to: "root/peer",
          recipientState: "waiting",
          broodControl: {
            version: 1,
            kind: "suspend",
            invocationId: "call_ask",
          },
        },
      }),
    ]);
    const continuedRequest = inspectControlToolResults(agentId, [
      askToolResult({
        details: {
          version: 1,
          request: makeRequestId("request_ask"),
          to: makeAgentPath("root/peer"),
          recipientState: "waiting",
          broodControl: {
            version: 1,
            kind: "continue",
            invocationId: makeToolInvocationId("call_ask"),
          },
        },
      }),
    ]);

    expect(malformed).toMatchObject({ _tag: "Malformed", error: { _tag: "PiProtocolError" } });
    expect(extra).toMatchObject({ _tag: "Malformed", error: { _tag: "PiProtocolError" } });
    expect(mismatch).toMatchObject({
      _tag: "Malformed",
      error: { message: expect.stringContaining("does not match") },
    });
    expect(malformedRequest).toMatchObject({
      _tag: "Malformed",
      error: { message: expect.stringContaining("Malformed ask_agent") },
    });
    expect(continuedRequest).toMatchObject({
      _tag: "Malformed",
      error: { message: expect.stringContaining("must suspend") },
    });
  });

  it("ignores failed known tools and unrelated marker-shaped results", () => {
    const unrelated = toolResult({ toolName: "read" });
    const failed = toolResult({ isError: true });
    const failedAsk = askToolResult({ isError: true, details: {} });
    expect(inspectControlToolResults(agentId, [unrelated, failed, failedAsk])).toEqual({
      _tag: "Continue",
    });
  });

  it("opens and scopes a real offline Pi session with the exact Brood tool set", async () => {
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-adapter-",
        providerName: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "low",
      },
      async ({ adapter, catalogue }) => {
        const tools = compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort);
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
      },
    );
  });

  it("derives the exact active-tool invariant from every requested custom tool", async () => {
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-adapter-extra-tool-",
        providerName: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "low",
      },
      async ({ adapter, catalogue }) => {
        const probe = defineTool({
          name: "probe",
          label: "Probe",
          description: "Extra adapter test tool",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        });
        const tools = [...compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort), probe];
        const sessionId = await Effect.runPromise(
          Effect.scoped(
            adapter
              .open({
                agentId,
                profile: catalogue.defaultProfile,
                tools,
                systemPrompt: "Brood dynamic tool-set test",
              })
              .pipe(Effect.map((agent) => agent.sessionId)),
          ),
        );

        expect(sessionId.length).toBeGreaterThan(0);
      },
    );
  });

  it("rejects duplicate requested or built-in tool names before opening a session", async () => {
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-adapter-duplicate-tool-",
        providerName: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "low",
      },
      async ({ adapter, catalogue }) => {
        const builtInCollision = defineTool({
          name: "read",
          label: "Duplicate read",
          description: "Must be rejected",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({ content: [{ type: "text", text: "bad" }], details: {} }),
        });
        const duplicatedCustom = defineTool({
          name: "probe",
          label: "Duplicate probe",
          description: "Must be rejected when supplied twice",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({ content: [{ type: "text", text: "bad" }], details: {} }),
        });
        const builtInResult = await Effect.runPromise(
          Effect.flip(
            Effect.scoped(
              adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools: [builtInCollision],
                systemPrompt: "Brood duplicate tool test",
              }),
            ),
          ),
        );
        const customResult = await Effect.runPromise(
          Effect.flip(
            Effect.scoped(
              adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools: [duplicatedCustom, duplicatedCustom],
                systemPrompt: "Brood duplicate custom tool test",
              }),
            ),
          ),
        );

        expect(builtInResult).toMatchObject({
          _tag: "PiOpenError",
          message: expect.stringContaining("Duplicate Pi tool name: read"),
        });
        expect(customResult).toMatchObject({
          _tag: "PiOpenError",
          message: expect.stringContaining("Duplicate Pi tool name: probe"),
        });
      },
    );
  });

  it("classifies a real scripted Pi completion at prompt settlement", async () => {
    const faux = fauxProvider({
      provider: "scripted-complete",
      models: [{ id: "scripted-small" }],
    });
    let observedSystemPrompt: string | undefined;
    faux.setResponses([
      (context) => {
        observedSystemPrompt = context.systemPrompt;
        return fauxAssistantMessage("finished", {
          stopReason: "stop",
          responseId: "response-1",
        });
      },
    ]);
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-complete-",
        provider: faux,
        providerName: "scripted-complete",
        modelId: "scripted-small",
        thinkingLevel: "off",
      },
      async ({ adapter, catalogue }) => {
        const completed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools: compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort),
                systemPrompt: "Brood scripted completion",
              });
              const monitor = yield* Effect.forkChild(
                Stream.runCollect(agent.events.pipe(Stream.take(4))),
              );
              const outcome = yield* agent.run("complete");
              const events = yield* Fiber.join(monitor);
              return { outcome, events: Array.from(events) };
            }),
          ),
        );
        expect(completed.outcome).toEqual({
          _tag: "Completed",
          result: {
            finalText: "finished",
            finalMessageId: "response-1",
            stopReason: "stop",
          },
          deliveredOperatorMessages: [],
        });
        expect(completed.events.map(({ sessionSequence }) => sessionSequence)).toEqual([
          1, 2, 3, 4,
        ]);
        expect(observedSystemPrompt).toContain("Brood scripted completion");
        expect(observedSystemPrompt).toContain("Current working directory:");
      },
    );
  });

  it("rejects concurrent runs without disturbing the owning prompt", async () => {
    const faux = fauxProvider({
      provider: "scripted-concurrent",
      models: [{ id: "scripted-small" }],
    });
    let releaseResponse: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    // Each resolver is assigned synchronously before the test reaches the corresponding await.
    const started = new Promise<void>((resolveStarted) => {
      announceStarted = resolveStarted;
    });
    faux.setResponses([
      async () => {
        announceStarted?.();
        await new Promise<void>((resolveResponse) => {
          releaseResponse = resolveResponse;
        });
        return fauxAssistantMessage("owner complete", { stopReason: "stop" });
      },
    ]);
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-concurrent-",
        provider: faux,
        providerName: "scripted-concurrent",
        modelId: "scripted-small",
        thinkingLevel: "off",
      },
      async ({ adapter, catalogue }) => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools: compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort),
                systemPrompt: "Brood concurrent run test",
              });
              const owner = yield* Effect.forkChild(agent.run("owner"));
              yield* Effect.promise(() => started);
              const second = yield* Effect.exit(agent.run("second"));
              const third = yield* Effect.exit(agent.run("third"));
              releaseResponse?.();
              const ownerOutcome = yield* Fiber.join(owner);
              return { ownerOutcome, second, third };
            }),
          ),
        );

        expect(result.ownerOutcome).toMatchObject({
          _tag: "Completed",
          result: { finalText: "owner complete" },
        });
        for (const rejected of [result.second, result.third]) {
          expect(Exit.isFailure(rejected)).toBe(true);
          const renderedCause = Exit.isFailure(rejected) ? Cause.pretty(rejected.cause) : "";
          expect(renderedCause).toContain("Concurrent Pi runs");
        }
        expect(faux.state.callCount).toBe(1);
      },
    );
  });

  it("stops a real scripted Pi turn after persisted delegate results", async () => {
    const faux = fauxProvider({
      provider: "scripted-suspend",
      models: [{ id: "scripted-small" }],
    });
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
      fauxAssistantMessage("resumed and done", { stopReason: "stop" }),
    ]);
    const port: ControlToolPort = {
      delegate: (_callerId, invocationId) =>
        Effect.succeed({
          version: 2,
          batchId: makeBatchId("batch_suspend"),
          agents: [
            {
              name: makeAgentName("child"),
              id: makeAgentId("agent_child"),
              profile: makeProfileName("worker"),
            },
          ],
          admissions: { limit: 8, used: 2, remaining: 6 },
          broodControl: { version: 1, kind: "suspend", invocationId },
        }),
      waitForAgents: () => Effect.die("unused"),
    };
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-suspend-",
        provider: faux,
        providerName: "scripted-suspend",
        modelId: "scripted-small",
        thinkingLevel: "off",
      },
      async ({ adapter, catalogue }) => {
        const outcomes = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools: compileAgentToolFactory(catalogue).forCaller(agentId, port),
                systemPrompt: "Brood scripted suspension",
              });
              const suspended = yield* agent.run("delegate");
              const resumed = yield* agent.run("dependency outcomes");
              return { suspended, resumed };
            }),
          ),
        );
        expect(outcomes.suspended).toEqual({
          _tag: "Suspended",
          deliveredOperatorMessages: [],
          markers: [
            {
              _tag: "AgentWait",
              tool: "delegate",
              invocationId: "call_suspend",
            },
          ],
        });
        expect(outcomes.resumed).toMatchObject({
          _tag: "Completed",
          result: { finalText: "resumed and done" },
        });
        expect(faux.state.callCount).toBe(2);
      },
    );
  });

  it("persists accepted ask details before returning a typed suspension", async () => {
    const faux = fauxProvider({
      provider: "scripted-ask-suspend",
      models: [{ id: "scripted-small" }],
    });
    let priorAskVisibleToNextRequest = false;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "ask_agent",
          {
            to: "root/peer",
            question: "Which invariant did you verify?",
          },
          { id: "call_ask_persisted" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        priorAskVisibleToNextRequest = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "ask_agent" &&
            message.toolCallId === "call_ask_persisted" &&
            !message.isError &&
            typeof message.details === "object" &&
            message.details !== null &&
            Reflect.get(message.details, "request") === "request_persisted",
        );
        return fauxAssistantMessage("reply received", { stopReason: "stop" });
      },
    ]);
    const communicationPort: CommunicationToolPort = {
      ...unusedCommunicationPort,
      askAgent: (_callerId, invocationId) =>
        Effect.succeed({
          version: 1,
          request: makeRequestId("request_persisted"),
          to: makeAgentPath("root/peer"),
          recipientState: "waiting",
          broodControl: { version: 1, kind: "suspend", invocationId },
        }),
    };

    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-ask-suspend-",
        provider: faux,
        providerName: "scripted-ask-suspend",
        modelId: "scripted-small",
        thinkingLevel: "off",
      },
      async ({ adapter, catalogue, directory }) => {
        const tools = [
          ...compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort),
          ...makeCommunicationTools(agentId, communicationPort),
        ];
        const outcomes = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* adapter.open({
                agentId,
                profile: catalogue.defaultProfile,
                tools,
                systemPrompt: "Brood scripted ask suspension",
              });
              const suspended = yield* agent.run("ask peer");
              const providerCallsAfterSuspend = faux.state.callCount;
              const transcriptDirectory = join(directory, "state", "sessions", agentId);
              const transcriptFiles = yield* Effect.promise(() =>
                readdir(transcriptDirectory, { recursive: true }),
              );
              const transcript = yield* Effect.promise(() =>
                Promise.all(
                  transcriptFiles
                    .filter((path) => path.endsWith(".jsonl"))
                    .map((path) => readFile(join(transcriptDirectory, path), "utf8")),
                ).then((parts) => parts.join("\n")),
              );
              const resumed = yield* agent.run("the peer replied");
              return { suspended, providerCallsAfterSuspend, transcript, resumed };
            }),
          ),
        );

        expect(outcomes.suspended).toEqual({
          _tag: "Suspended",
          deliveredOperatorMessages: [],
          markers: [
            {
              _tag: "RequestWait",
              tool: "ask_agent",
              invocationId: "call_ask_persisted",
              request: "request_persisted",
            },
          ],
        });
        expect(outcomes.transcript).toContain('"toolName":"ask_agent"');
        expect(outcomes.transcript).toContain('"request":"request_persisted"');
        expect(outcomes.transcript).toContain('"kind":"suspend"');
        expect(outcomes.providerCallsAfterSuspend).toBe(1);
        expect(priorAskVisibleToNextRequest).toBe(true);
        expect(outcomes.resumed).toMatchObject({
          _tag: "Completed",
          result: { finalText: "reply received" },
        });
      },
    );
  });
});

describe("Session resume and repair", () => {
  it("reopens the same session file on a second open and replays the first life's context", async () => {
    const faux = fauxProvider({
      provider: "scripted-resume",
      models: [{ id: "scripted-small" }],
    });
    let secondLifeContextMessages: number | undefined;
    faux.setResponses([
      () => fauxAssistantMessage("first life answer", { stopReason: "stop", responseId: "r1" }),
      (context) => {
        secondLifeContextMessages = context.messages.length;
        return fauxAssistantMessage("second life answer", { stopReason: "stop", responseId: "r2" });
      },
    ]);
    await withOfflinePiAdapter(
      {
        prefix: "brood-pi-resume-",
        provider: faux,
        providerName: "scripted-resume",
        modelId: "scripted-small",
        thinkingLevel: "off",
      },
      async ({ adapter, catalogue, directory }) => {
        const openAndRun = (prompt: string) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* adapter.open({
                  agentId,
                  profile: catalogue.defaultProfile,
                  tools: compileAgentToolFactory(catalogue).forCaller(agentId, unusedPort),
                  systemPrompt: "Brood resume test",
                });
                const outcome = yield* agent.run(prompt);
                return { outcome, sessionId: agent.sessionId };
              }),
            ),
          );

        const sessionDirectory = join(directory, "state", "sessions", agentId);
        const first = await openAndRun("do the work");
        const afterFirst = await readdir(sessionDirectory);
        const second = await openAndRun("you are revived");
        const afterSecond = await readdir(sessionDirectory);

        // One file, one identity, both lives on it.
        expect(afterFirst.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
        expect(afterSecond).toEqual(afterFirst);
        expect(second.sessionId).toBe(first.sessionId);
        expect(first.outcome._tag).toBe("Completed");
        expect(second.outcome._tag).toBe("Completed");
        // The second life's model call saw the first conversation: first
        // prompt, first answer, and the revival prompt at minimum.
        expect(secondLifeContextMessages ?? 0).toBeGreaterThanOrEqual(3);
        const raw = await readFile(join(sessionDirectory, afterFirst[0]!), "utf8");
        expect(raw).toContain("first life answer");
        expect(raw).toContain("second life answer");
      },
    );
  });

  it("appends synthetic aborted results for dangling tool calls, chained onto the entry tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-shim-"));
    try {
      expect(await findLatestSessionFile(directory)).toBeUndefined();

      const file = join(directory, "2026-08-14T00-00-00-000Z_shim.jsonl");
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const entries = [
        {
          type: "session",
          version: 3,
          id: "shimsess",
          timestamp: "2026-08-14T00:00:00.000Z",
          cwd: directory,
        },
        {
          type: "message",
          id: "aaaa0001",
          parentId: null,
          timestamp: "2026-08-14T00:00:01.000Z",
          message: { role: "user", content: "go", timestamp: 1 },
        },
        {
          type: "message",
          id: "aaaa0002",
          parentId: "aaaa0001",
          timestamp: "2026-08-14T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "running the batch" },
              { type: "toolCall", id: "call_a", name: "read", arguments: {} },
              { type: "toolCall", id: "call_b", name: "write", arguments: {} },
              { type: "toolCall", id: "call_c", name: "bash", arguments: {} },
            ],
            api: "faux",
            provider: "scripted",
            model: "scripted-small",
            usage,
            stopReason: "toolUse",
            timestamp: 2,
          },
        },
        {
          type: "message",
          id: "aaaa0003",
          parentId: "aaaa0002",
          timestamp: "2026-08-14T00:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_a",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 3,
          },
        },
      ];
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

      expect(await findLatestSessionFile(directory)).toBe(file);
      const repaired = await repairDanglingToolCalls(file);
      expect(repaired).toBe(2);

      const lines = (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(6);
      const [syntheticB, syntheticC] = lines.slice(4) as Array<{
        id: string;
        parentId: string;
        message: Record<string, unknown>;
      }>;
      expect(syntheticB!.message).toMatchObject({
        role: "toolResult",
        toolCallId: "call_b",
        toolName: "write",
        isError: true,
      });
      expect(syntheticC!.message).toMatchObject({
        role: "toolResult",
        toolCallId: "call_c",
        toolName: "bash",
        isError: true,
      });
      expect(syntheticB!.parentId).toBe("aaaa0003");
      expect(syntheticC!.parentId).toBe(syntheticB!.id);

      // Idempotent: a second pass finds nothing dangling.
      expect(await repairDanglingToolCalls(file)).toBe(0);

      // And Pi itself can load the repaired file into a balanced context.
      const manager = SessionManager.open(file, directory);
      const context = manager.buildSessionContext();
      const toolResults = context.messages.filter((message) => message.role === "toolResult");
      expect(toolResults).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
