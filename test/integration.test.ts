// Plain Vitest is intentional: this is the real offline Pi/session integration boundary.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { compileProfileCatalogue } from "../src/profiles.js";
import { makePiAdapter } from "../src/pi-adapter.js";
import { makeSupervisor } from "../src/supervisor.js";

it("runs a real offline root-child-grandchild swarm through Pi at concurrency one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brood-integration-"));
  try {
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({
      provider: "scripted-brood-integration",
      models: [{ id: "scripted-small" }],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("scripted-brood-integration", "offline-test-key");
    await modelRuntime.refresh({
      allowNetwork: false,
      providers: ["scripted-brood-integration"],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "delegate",
          {
            tasks: [{ name: "child", goal: "delegate one grandchild", profile: "researcher" }],
            wait: "all",
          },
          { id: "root_delegate" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "delegate",
          {
            tasks: [{ name: "grandchild", goal: "produce the leaf result" }],
            wait: "all",
          },
          { id: "child_delegate" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("leaf complete", { stopReason: "stop" }),
      fauxAssistantMessage("child synthesized leaf", { stopReason: "stop" }),
      fauxAssistantMessage("root synthesized swarm", { stopReason: "stop" }),
    ]);

    const catalogue = await Effect.runPromise(
      compileProfileCatalogue(
        {
          defaultProfile: "worker",
          rootProfile: "coordinator",
          profiles: {
            coordinator: {
              description: "coordinates",
              provider: "scripted-brood-integration",
              model: "scripted-small",
              thinkingLevel: "off",
            },
            researcher: {
              description: "researches",
              provider: "scripted-brood-integration",
              model: "scripted-small",
              thinkingLevel: "off",
            },
            worker: {
              description: "works",
              provider: "scripted-brood-integration",
              model: "scripted-small",
              thinkingLevel: "off",
            },
          },
        },
        { getModel: (provider, id) => modelRuntime.getModel(provider, id) },
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

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor({
            catalogue,
            piAdapter: adapter,
            maxConcurrency: 1,
            maxAgents: 8,
            maxAgentResultChars: 12_000,
            maxFailureMessageChars: 2_000,
            maxResumePromptChars: 48_000,
            drainTimeoutMillis: 60_000,
          });
          const rootId = yield* supervisor.startRoot("coordinate recursively");
          const rootOutcome = yield* supervisor.awaitOutcome(rootId);
          const drain = yield* supervisor.drain;
          const status = yield* supervisor.status;
          const details = yield* Effect.all([
            supervisor.show("root"),
            supervisor.show("root/child"),
            supervisor.show("root/child/grandchild"),
          ]);
          return { rootOutcome, drain, status, details };
        }),
      ),
    );

    expect(result.rootOutcome).toMatchObject({
      _tag: "Completed",
      result: { summary: "root synthesized swarm" },
    });
    expect(result.drain).toEqual({
      timedOut: false,
      interruptedAgentIds: [],
      terminalAgentCount: 3,
    });
    expect(result.status.agents).toMatchObject([
      {
        path: "root",
        state: "completed",
        children: [
          {
            path: "root/child",
            state: "completed",
            children: [{ path: "root/child/grandchild", state: "completed" }],
          },
        ],
      },
    ]);
    expect(result.status.state).toBe("completed");
    expect(result.status.capacity.runs.active).toBe(0);
    expect(result.details.map(({ profile }) => profile.name)).toEqual([
      "coordinator",
      "researcher",
      "worker",
    ]);
    expect(result.details[1]?.parentId).toBe(result.details[0]?.id);
    expect(result.details[2]?.parentId).toBe(result.details[1]?.id);
    const sessionIds = result.details.flatMap(({ outcome }) =>
      outcome?._tag === "Completed" ? [outcome.result.sessionId] : [],
    );
    expect(new Set(sessionIds).size).toBe(3);
    expect(faux.state.callCount).toBe(5);

    const sessionDirectory = join(directory, "state", "sessions");
    const entries = await readdir(sessionDirectory, { recursive: true });
    const transcripts = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => readFile(join(sessionDirectory, entry), "utf8")),
    );
    const assertSuspendingTranscript = (toolCallId: string): void => {
      const transcript = transcripts.find((content) => content.includes(toolCallId));
      expect(transcript).toBeDefined();
      const firstCall = transcript?.indexOf(toolCallId) ?? -1;
      const matchingResult = transcript?.indexOf(toolCallId, firstCall + toolCallId.length) ?? -1;
      const resume = transcript?.indexOf("brood_dependency_outcomes", matchingResult) ?? -1;
      expect(firstCall).toBeGreaterThanOrEqual(0);
      expect(matchingResult).toBeGreaterThan(firstCall);
      expect(resume).toBeGreaterThan(matchingResult);
    };
    assertSuspendingTranscript("root_delegate");
    assertSuspendingTranscript("child_delegate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
