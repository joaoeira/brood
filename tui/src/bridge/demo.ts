/**
 * A scripted swarm that needs no network, no credentials, and no Pi. It drives
 * the same store the live bridge does, so every screen can be exercised — and
 * smoke-tested — offline.
 *
 * The timeline below is deliberately shaped to hit the awkward states rather
 * than the happy path: a parent that suspends on three children, a child that
 * fails a tool and then fails outright, an ask/reply pair, two bulletins, and a
 * compaction marker inside one of the synthetic transcripts.
 */
import type { AgentDetail, StatusAgent, SupervisorEvent, SwarmStatus, TrafficView } from "../brood";
import { store } from "../store";
import { makeMemoryTranscriptReader } from "../transcript/watch";
import type { BridgeHandle, ConfigSummary } from "./types";

const TICK_MILLIS = 200;
const DRAIN_MILLIS = 900;
const REVIVAL_MILLIS = 2_600;

/**
 * Brood's ids, names, and profile names are branded at the schema boundary.
 * Demo fixtures are hand-written rather than decoded, so the brands are
 * asserted here in one place instead of scattered across the timeline.
 */
const brand = <T extends string>(value: string): T => value as unknown as T;

type AgentState = StatusAgent["state"];
type Profile = AgentDetail["profile"];
type Outcome = NonNullable<AgentDetail["outcome"]>;

interface DemoAgent {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  state: AgentState;
  activity?: string | undefined;
  waitTargets: ReadonlyArray<string>;
  readonly createdAt: number;
  terminalAt?: number | undefined;
  readonly profile: Profile;
  outcome?: Outcome | undefined;
  coordination?: StatusAgent["coordination"] | undefined;
  revivals?: number | undefined;
}

interface DemoTrafficRecord {
  readonly sequence: number;
  readonly at: number;
  readonly kind: TrafficView["kind"];
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly urgent: boolean;
  status: TrafficView["status"];
  statusAt?: number;
  readonly requestId?: string;
}

const profile = (
  name: string,
  model: string,
  thinkingLevel: Profile["thinkingLevel"],
): Profile => ({
  name: brand(name),
  provider: "anthropic",
  model,
  thinkingLevel,
});

const COORDINATOR = profile("coordinator", "claude-sonnet-4-5", "high");
const WORKER = profile("worker", "claude-sonnet-4-5", "medium");

const jsonl = (lines: ReadonlyArray<unknown>): string =>
  lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

const sessionHeader = (id: string) => ({
  type: "session",
  version: 3,
  id,
  timestamp: new Date().toISOString(),
  cwd: "/Users/demo/code/side-project",
});

let entryCounter = 0;
const messageEntry = (message: unknown) => {
  entryCounter += 1;
  return {
    type: "message",
    id: `e${entryCounter.toString(16).padStart(8, "0")}`,
    parentId: entryCounter === 1 ? null : `e${(entryCounter - 1).toString(16).padStart(8, "0")}`,
    timestamp: new Date().toISOString(),
    message,
  };
};

const userMessage = (text: string) =>
  messageEntry({ role: "user", content: text, timestamp: Date.now() });

const assistantMessage = (
  text: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }> = [],
) =>
  messageEntry({
    role: "assistant",
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...calls.map((call) => ({ type: "toolCall", ...call })),
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: calls.length === 0 ? "stop" : "toolUse",
    timestamp: Date.now(),
  });

const toolResult = (
  toolCallId: string,
  toolName: string,
  text: string,
  options: { isError?: boolean; suspend?: boolean } = {},
) =>
  messageEntry({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: options.isError === true,
    timestamp: Date.now(),
    ...(options.suspend === true
      ? {
          details: {
            version: 1,
            broodControl: { version: 1, kind: "suspend", invocationId: "inv_1" },
          },
        }
      : {}),
  });

const buildTranscripts = (): ReadonlyMap<string, { fileName: string; text: string }> =>
  new Map([
    [
      "agt_root",
      {
        fileName: "2026-08-10T09-14-02-113Z_0192f3c1.jsonl",
        text: jsonl([
          sessionHeader("0192f3c1"),
          userMessage(
            '<brood_runtime version="1">\n  <profiles>coordinator, worker</profiles>\n  <limits admissions="128" concurrency="4" />\n</brood_runtime>',
          ),
          userMessage("Ship the public read API for the changelog service."),
          assistantMessage(
            "Three pieces can move in parallel: the HTTP surface, the response schema, and a coherence audit once both land. I'll delegate all three and wait.",
            [
              {
                id: "call_delegate_1",
                name: "delegate",
                arguments: {
                  agents: [
                    { name: "api", goal: "Implement the HTTP read endpoints" },
                    { name: "schema", goal: "Define and validate the response schema" },
                    { name: "audit", goal: "Cross-check the two for coherence" },
                  ],
                },
              },
            ],
          ),
          toolResult("call_delegate_1", "delegate", "Admitted 3 agents: api, schema, audit.", {
            suspend: true,
          }),
          {
            type: "compaction",
            id: "c0000001",
            parentId: null,
            timestamp: new Date().toISOString(),
            summary: "Planning discussion condensed; delegation decisions retained.",
            firstKeptEntryId: "e00000003",
            tokensBefore: 48_120,
          },
          assistantMessage(
            "api and audit completed; schema failed on its validation pass. The read API is usable, but the schema work needs a second attempt before this ships.",
          ),
        ]),
      },
    ],
    [
      "agt_api",
      {
        fileName: "2026-08-10T09-14-05-882Z_0192f3c2.jsonl",
        text: jsonl([
          sessionHeader("0192f3c2"),
          userMessage("Implement the HTTP read endpoints for the changelog service."),
          assistantMessage("Reading the existing router first.", [
            { id: "call_read_1", name: "read_file", arguments: { path: "src/router.ts" } },
          ]),
          toolResult(
            "call_read_1",
            "read_file",
            "export const router = createRouter();  // 214 lines",
          ),
          assistantMessage("Adding the two read handlers.", [
            {
              id: "call_write_1",
              name: "write_file",
              arguments: { path: "src/routes/changelog.ts", contents: "…" },
            },
          ]),
          toolResult("call_write_1", "write_file", "Wrote 96 lines to src/routes/changelog.ts"),
          assistantMessage(
            "Both endpoints are in: GET /changelog paginates by cursor and GET /changelog/:id returns a single entry. Handlers are covered by the existing router tests.",
          ),
        ]),
      },
    ],
    [
      "agt_schema",
      {
        fileName: "2026-08-10T09-14-06-004Z_0192f3c3.jsonl",
        text: jsonl([
          sessionHeader("0192f3c3"),
          userMessage("Define and validate the response schema."),
          assistantMessage("Running the validator against the fixtures.", [
            { id: "call_bash_1", name: "bash", arguments: { command: "pnpm validate:schema" } },
          ]),
          toolResult("call_bash_1", "bash", "error: 3 fixtures rejected by cursor field", {
            isError: true,
          }),
          assistantMessage(
            "The cursor field is typed as an opaque string upstream but the fixtures encode it as an integer. I cannot reconcile that without a decision on the wire format.",
          ),
        ]),
      },
    ],
    [
      "agt_peer",
      {
        fileName: "2026-08-10T09-14-09-441Z_0192f3c4.jsonl",
        text: jsonl([
          sessionHeader("0192f3c4"),
          userMessage("Draft the pagination helper the read endpoints need."),
          assistantMessage("Checking with the parent on cursor encoding before I commit to one.", [
            {
              id: "call_ask_1",
              name: "ask_agent",
              arguments: { to: "root/api", question: "Opaque cursor or numeric offset?" },
            },
          ]),
          toolResult("call_ask_1", "ask_agent", "Question delivered to root/api.", {
            suspend: true,
          }),
          assistantMessage("Opaque cursor it is. Helper written and exported."),
        ]),
      },
    ],
  ]);

export const createDemoBridge = (): BridgeHandle => {
  const agents = new Map<string, DemoAgent>();
  const transcripts = buildTranscripts();
  const bulletins: Array<{ sequence: number; author: string; body: string }> = [];
  const traffic: Array<DemoTrafficRecord> = [];

  let sequence = 0;
  let startedAt: number | undefined;
  let finishedAt: number | undefined;
  let lifecycle: SwarmStatus["state"] = "not_started";
  let elapsed = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;

  const now = (): number => Date.now();

  const emit = (lifecycleEvent: Record<string, unknown>): void => {
    sequence += 1;
    store.onEvent({
      source: "supervisor",
      sequence,
      timestamp: now(),
      ...lifecycleEvent,
    } as unknown as SupervisorEvent);
  };

  const emitPi = (agentId: string, event: Record<string, unknown>): void => {
    store.onEvent({
      source: "pi",
      timestamp: now(),
      event: { agentId: brand(agentId), sessionId: "demo", sessionSequence: sequence, ...event },
    } as unknown as SupervisorEvent);
  };

  const pathOf = (id: string): string => {
    const agent = agents.get(id);
    if (agent === undefined) return id;
    return agent.parentId === undefined ? agent.name : `${pathOf(agent.parentId)}/${agent.name}`;
  };

  const add = (
    id: string,
    name: string,
    agentProfile: Profile,
    parentId?: string,
    state: AgentState = "starting",
  ): void => {
    agents.set(id, {
      id,
      name,
      ...(parentId === undefined ? {} : { parentId }),
      state,
      waitTargets: [],
      createdAt: now(),
      profile: agentProfile,
    });
    emit({
      type: "AgentRegistered",
      agentId: brand(id),
      name: brand(name),
      ...(parentId === undefined ? {} : { parentId: brand(parentId) }),
      profile: agentProfile,
    });
  };

  const update = (id: string, changes: Partial<DemoAgent>): void => {
    const agent = agents.get(id);
    if (agent === undefined) return;
    Object.assign(agent, changes);
  };

  const settle = (
    id: string,
    status: "Completed" | "Failed" | "Interrupted",
    outcome: Outcome,
  ): void => {
    const state: AgentState =
      status === "Completed" ? "completed" : status === "Failed" ? "failed" : "interrupted";
    update(id, { state, terminalAt: now(), outcome, activity: undefined, waitTargets: [] });
    emit({ type: "AgentSettled", agentId: brand(id), status });
  };

  /**
   * An operator message to a finished agent brings it back: the demo mirrors
   * the real thing by clearing the outcome, counting the revival, and letting
   * the agent work for a beat before it settles again.
   */
  const revive = (id: string): void => {
    const agent = agents.get(id);
    if (agent === undefined) return;
    const revivals = (agent.revivals ?? 0) + 1;
    update(id, {
      state: "running",
      revivals,
      terminalAt: undefined,
      outcome: undefined,
      activity: "reading the operator message",
    });
    emit({ type: "AgentRevived", agentId: brand(id), revivals });
    publishStatus();
    setTimeout(() => {
      if (agents.get(id)?.state !== "running") return;
      settle(
        id,
        "Completed",
        completed(id, `Picked the thread back up on the operator's steer (revival ${revivals}).`),
      );
      publishStatus();
    }, REVIVAL_MILLIS);
  };

  const completed = (id: string, summary: string): Outcome => ({
    _tag: "Completed",
    agentId: brand(id),
    name: brand(agents.get(id)?.name ?? id),
    result: {
      agentId: brand(id),
      sessionId: "demo",
      summary,
      truncated: false,
      originalCharacterCount: summary.length,
    },
  });

  const statusAgent = (agent: DemoAgent, children: ReadonlyArray<DemoAgent>): StatusAgent => ({
    path: pathOf(agent.id),
    name: agent.name,
    state: agent.state,
    durationMillis: Math.max(0, (agent.terminalAt ?? now()) - agent.createdAt),
    ...(agent.activity === undefined ? {} : { activity: agent.activity }),
    ...(agent.coordination === undefined ? {} : { coordination: agent.coordination }),
    ...(agent.revivals === undefined || agent.revivals === 0 ? {} : { revivals: agent.revivals }),
    waitTargets: agent.waitTargets.map(pathOf),
    children: children.map((child) => statusAgent(child, childrenOf(child.id))),
  });

  const childrenOf = (id: string): ReadonlyArray<DemoAgent> =>
    [...agents.values()].filter((candidate) => candidate.parentId === id);

  const buildStatus = (): SwarmStatus => {
    const all = [...agents.values()];
    const counts = {
      starting: 0,
      queued: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
    };
    for (const agent of all) counts[agent.state] += 1;
    const used = all.length;
    const limit = 128;
    const active = counts.running + counts.starting;
    return {
      version: 2,
      state: lifecycle,
      elapsedMillis: startedAt === undefined ? 0 : Math.max(0, (finishedAt ?? now()) - startedAt),
      capacity: {
        admissions: { limit, used, remaining: limit - used },
        runs: { active, limit: 4, available: Math.max(0, 4 - active) },
      },
      counts,
      agents: all
        .filter((agent) => agent.parentId === undefined)
        .map((agent) => statusAgent(agent, childrenOf(agent.id))),
    };
  };

  const publishStatus = (): void => store.setStatus(buildStatus());

  const publishTraffic = (): void =>
    store.setTraffic(
      traffic.map((record) => ({
        sequence: record.sequence,
        at: record.at,
        kind: record.kind,
        from: record.from,
        to: brand(record.to),
        body: record.body,
        urgent: record.urgent,
        status: record.status,
        ...(record.statusAt === undefined ? {} : { statusAt: record.statusAt }),
        ...(record.requestId === undefined ? {} : { requestId: brand(record.requestId) }),
      })),
    );

  const pushTraffic = (record: Omit<DemoTrafficRecord, "sequence" | "at">): DemoTrafficRecord => {
    const stored: DemoTrafficRecord = { ...record, sequence: traffic.length + 1, at: now() };
    traffic.push(stored);
    publishTraffic();
    return stored;
  };

  const markTraffic = (
    predicate: (record: DemoTrafficRecord) => boolean,
    status: TrafficView["status"],
  ): void => {
    for (const record of traffic) {
      if (!predicate(record)) continue;
      record.status = status;
      record.statusAt = now();
    }
    publishTraffic();
  };

  const publishBulletins = (): void =>
    store.setBulletins(
      bulletins.map((entry) => ({
        sequence: entry.sequence,
        author: brand(entry.author),
        body: entry.body,
      })),
    );

  const bulletin = (authorId: string, body: string): void => {
    bulletins.push({ sequence: bulletins.length + 1, author: pathOf(authorId), body });
    emit({ type: "BulletinPosted", authorId: brand(authorId) });
    publishBulletins();
  };

  // ── The script ────────────────────────────────────────────────────────────
  const script: ReadonlyArray<{ at: number; run: () => void }> = [
    {
      at: 0,
      run: () => {
        add("agt_root", "root", COORDINATOR, undefined, "running");
        update("agt_root", { activity: "planning the split" });
      },
    },
    { at: 800, run: () => update("agt_root", { activity: "delegating three tracks" }) },
    {
      at: 1_400,
      run: () => {
        add("agt_api", "api", WORKER, "agt_root", "running");
        add("agt_schema", "schema", WORKER, "agt_root", "running");
        add("agt_audit", "audit", WORKER, "agt_root", "queued");
        emit({
          type: "BatchAdmitted",
          parentId: brand("agt_root"),
          batchId: brand("batch_1"),
          agentIds: ["agt_api", "agt_schema", "agt_audit"].map((id) => brand(id)),
        });
      },
    },
    {
      at: 1_900,
      run: () => {
        const targets = ["agt_api", "agt_schema", "agt_audit"];
        emit({
          type: "WaitPlanned",
          parentId: brand("agt_root"),
          invocationId: brand("inv_1"),
          targetIds: targets.map((id) => brand(id)),
        });
        update("agt_root", { state: "waiting", waitTargets: targets, activity: undefined });
        emit({
          type: "AgentSuspended",
          agentId: brand("agt_root"),
          waitId: brand("wait_1"),
          targetIds: targets.map((id) => brand(id)),
        });
      },
    },
    {
      at: 2_300,
      run: () => {
        update("agt_api", { activity: "reading the existing router" });
        emitPi("agt_api", { type: "ToolStart", toolCallId: "call_read_1", toolName: "read_file" });
      },
    },
    {
      at: 3_000,
      run: () =>
        emitPi("agt_api", { type: "ToolEnd", toolCallId: "call_read_1", toolName: "read_file" }),
    },
    {
      at: 3_300,
      run: () => {
        update("agt_api", { activity: "drafting the read handlers" });
        emitPi("agt_api", {
          type: "ToolStart",
          toolCallId: "call_write_1",
          toolName: "write_file",
        });
      },
    },
    {
      at: 3_900,
      run: () => {
        add("agt_peer", "peer", WORKER, "agt_api", "starting");
        emit({
          type: "BatchAdmitted",
          parentId: brand("agt_api"),
          batchId: brand("batch_2"),
          agentIds: [brand("agt_peer")],
        });
      },
    },
    {
      at: 4_500,
      run: () =>
        update("agt_peer", { state: "running", activity: "drafting the pagination helper" }),
    },
    {
      at: 5_000,
      run: () => {
        emit({
          type: "RequestOpened",
          requestId: brand("req_1"),
          fromId: brand("agt_peer"),
          toPath: brand("root/api"),
        });
        pushTraffic({
          kind: "request",
          from: "root/api/peer",
          to: "root/api",
          body: "Opaque cursor or numeric offset?",
          urgent: false,
          status: "unread",
          requestId: "req_1",
        });
      },
    },
    {
      at: 5_600,
      run: () => {
        emit({
          type: "RequestReplied",
          requestId: brand("req_1"),
          byId: brand("agt_api"),
          toPath: brand("root/api/peer"),
        });
        markTraffic((record) => record.requestId === "req_1", "answered");
        pushTraffic({
          kind: "reply",
          from: "root/api",
          to: "root/api/peer",
          body: "Opaque cursor. Use the shared helper in src/routes/pagination.ts.",
          urgent: false,
          status: "sent",
          requestId: "req_1",
        });
      },
    },
    {
      at: 9_200,
      run: () => {
        emit({
          type: "MessageAccepted",
          fromId: brand("agt_schema"),
          toPath: brand("root"),
          urgent: true,
        });
        pushTraffic({
          kind: "message",
          from: "root/schema",
          to: "root",
          body: "Fixture validation is failing on the cursor field; the wire format needs a decision before anything else ships.",
          urgent: true,
          status: "unread",
        });
        update("agt_root", {
          coordination: {
            unreadMessages: 1,
            unreadUrgent: 1,
            openRequestsIncoming: 0,
            openRequestsOutgoing: 0,
            pendingOperatorMessages: 0,
            unseenBulletins: 0,
          },
        });
      },
    },
    {
      at: 6_100,
      run: () => {
        update("agt_schema", { activity: "validating fixtures" });
        emitPi("agt_schema", { type: "ToolStart", toolCallId: "call_bash_1", toolName: "bash" });
      },
    },
    {
      at: 6_900,
      run: () =>
        emitPi("agt_schema", {
          type: "ToolEnd",
          toolCallId: "call_bash_1",
          toolName: "bash",
          isError: true,
        }),
    },
    {
      at: 7_400,
      run: () =>
        bulletin(
          "agt_api",
          "Cursor encoding is settled: opaque base64 of (published_at, id). Anything paginating the changelog should use the shared helper in src/routes/pagination.ts rather than rolling its own.",
        ),
    },
    {
      at: 8_200,
      run: () =>
        settle(
          "agt_peer",
          "Completed",
          completed("agt_peer", "Pagination helper written and exported."),
        ),
    },
    {
      at: 8_800,
      run: () => {
        emitPi("agt_api", { type: "ToolEnd", toolCallId: "call_write_1", toolName: "write_file" });
        settle(
          "agt_api",
          "Completed",
          completed(
            "agt_api",
            "Both read endpoints are in place.\nGET /changelog paginates by opaque cursor.\nGET /changelog/:id returns a single entry.\nCovered by the existing router tests; no new dependencies.",
          ),
        );
      },
    },
    {
      at: 9_700,
      run: () =>
        settle("agt_schema", "Failed", {
          _tag: "Failed",
          agentId: brand("agt_schema"),
          name: brand("schema"),
          code: "AgentRunFailed",
          message:
            "Fixture validation rejected 3 of 12 samples: the cursor field is an opaque string upstream but an integer in the fixtures. Reconciling needs a wire-format decision this agent cannot make alone.",
        }),
    },
    {
      at: 10_600,
      run: () => update("agt_audit", { state: "running", activity: "cross-checking both tracks" }),
    },
    {
      at: 11_800,
      run: () =>
        bulletin(
          "agt_audit",
          "Coherence check: the endpoints and the schema disagree on one field only (cursor). Everything else lines up, so this is a single-decision block rather than a redesign.",
        ),
    },
    {
      at: 13_000,
      run: () =>
        settle(
          "agt_audit",
          "Completed",
          completed(
            "agt_audit",
            "One disagreement found: cursor typing. No other coherence issues.",
          ),
        ),
    },
    {
      at: 14_000,
      run: () => {
        emit({ type: "AgentResumed", agentId: brand("agt_root"), waitId: brand("wait_1") });
        emit({ type: "InboxRead", readerId: brand("agt_root"), messages: 1, requests: 0 });
        markTraffic((record) => record.kind === "message" && record.to === "root", "read");
        update("agt_root", {
          state: "running",
          waitTargets: [],
          activity: "synthesizing results",
          coordination: undefined,
        });
      },
    },
    {
      at: 16_000,
      run: () => {
        settle(
          "agt_root",
          "Completed",
          completed(
            "agt_root",
            "The read API ships; the schema track does not.\nGET /changelog and GET /changelog/:id are implemented and tested.\nThe schema agent failed on a wire-format disagreement about the cursor field, which needs an operator decision before a second attempt.",
          ),
        );
        // Session mode: a finished root settles the swarm instead of ending
        // the run. Nothing drains until the operator closes, and every
        // completed agent stays revivable by an operator message.
        stopTimeline();
      },
    },
  ];

  const stopTimeline = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const tick = (): void => {
    elapsed += TICK_MILLIS;
    while (cursor < script.length) {
      const step = script[cursor];
      if (step === undefined || step.at > elapsed) break;
      cursor += 1;
      step.run();
    }
    publishStatus();
  };

  const configSummary: ConfigSummary = {
    configPath: "brood.demo.json",
    workspacePath: "/Users/demo/code/side-project",
    sessionDirectory: "/Users/demo/.brood/sessions",
    maxConcurrency: 4,
    maxAgentAdmissions: 128,
    defaultProfile: "worker",
    profileNames: ["coordinator", "worker"],
    authLabel: "demo · no credentials needed",
  };

  return {
    mode: "demo",
    configSummary,
    transcript: makeMemoryTranscriptReader((agentId) => transcripts.get(agentId)),

    start: (goal) => {
      if (startedAt !== undefined) return;
      startedAt = now();
      lifecycle = "running";
      store.note(`run started — ${goal}`, "info");
      publishStatus();
      timer = setInterval(tick, TICK_MILLIS);
    },

    refreshStatus: async () => {
      publishStatus();
    },

    fetchDetail: async (reference) => {
      const agent = [...agents.values()].find(
        (candidate) => candidate.id === reference || pathOf(candidate.id) === reference,
      );
      if (agent === undefined) {
        store.setDetail(undefined);
        return;
      }
      const parent = agent.parentId === undefined ? undefined : agents.get(agent.parentId);
      store.setDetail({
        version: 2,
        path: pathOf(agent.id),
        id: brand(agent.id),
        ...(agent.parentId === undefined ? {} : { parentId: brand(agent.parentId) }),
        ...(parent === undefined ? {} : { parentPath: pathOf(parent.id) }),
        name: brand(agent.name),
        state: agent.state,
        durationMillis: Math.max(0, (agent.terminalAt ?? now()) - agent.createdAt),
        ...(agent.activity === undefined ? {} : { activity: agent.activity }),
        waitTargets: agent.waitTargets.map(pathOf),
        children: childrenOf(agent.id).map((child) => pathOf(child.id)),
        profile: agent.profile,
        createdAt: agent.createdAt,
        updatedAt: now(),
        ...(agent.terminalAt === undefined ? {} : { terminalAt: agent.terminalAt }),
        ...(agent.outcome === undefined ? {} : { outcome: agent.outcome }),
        ...(agent.revivals === undefined || agent.revivals === 0
          ? {}
          : { revivals: agent.revivals }),
      });
    },

    fetchBulletins: async () => {
      publishBulletins();
    },

    fetchTraffic: async () => {
      publishTraffic();
    },

    sendOperatorMessage: async (reference, body) => {
      const agent = [...agents.values()].find(
        (candidate) => candidate.id === reference || pathOf(candidate.id) === reference,
      );
      if (agent === undefined) return `No agent is known at ${reference}.`;
      if (agent.state === "failed") {
        return `${pathOf(agent.id)} failed and cannot be revived.`;
      }
      if (lifecycle !== "running") {
        return `The swarm is ${lifecycle === "not_started" ? "not running" : "closing"}.`;
      }
      if (body.trim() === "") return "Operator messages must be nonblank.";
      emit({ type: "OperatorMessageAccepted", toId: brand(agent.id) });
      if (agent.terminalAt !== undefined) revive(agent.id);
      const record = pushTraffic({
        kind: "operator",
        from: "operator",
        to: pathOf(agent.id),
        body,
        urgent: true,
        status: "pending",
      });
      setTimeout(() => {
        markTraffic((candidate) => candidate.sequence === record.sequence, "delivered");
      }, 700);
      store.note(`operator → ${pathOf(agent.id)}  message delivered`, "info");
      return undefined;
    },

    interrupt: async (reference) => {
      const agent = [...agents.values()].find(
        (candidate) => candidate.id === reference || pathOf(candidate.id) === reference,
      );
      if (agent === undefined || agent.terminalAt !== undefined) return;
      emit({
        type: "AgentInterruptRequested",
        agentId: brand(agent.id),
        reason: { _tag: "OperatorRequested", source: "api" },
      });
      settle(agent.id, "Interrupted", {
        _tag: "Interrupted",
        agentId: brand(agent.id),
        name: brand(agent.name),
        reason: "OperatorRequested",
      });
      publishStatus();
    },

    close: async () => {
      stopTimeline();
      if (startedAt === undefined || lifecycle === "completed") return;
      lifecycle = "draining";
      emit({ type: "DrainStarted" });
      for (const agent of agents.values()) {
        if (agent.terminalAt !== undefined) continue;
        settle(agent.id, "Interrupted", {
          _tag: "Interrupted",
          agentId: brand(agent.id),
          name: brand(agent.name),
          reason: "OperatorRequested",
        });
      }
      publishStatus();
      await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MILLIS));
      lifecycle = "completed";
      finishedAt = now();
      emit({
        type: "DrainCompleted",
        report: { timedOut: false, interruptedAgentIds: [], terminalAgentCount: agents.size },
      });
      // The run resolves with the root's latest delivered result, exactly as
      // session mode does when the operator closes a live swarm.
      const root = agents.get("agt_root");
      store.setRunOutcome(
        root?.outcome?._tag === "Completed"
          ? { kind: "completed", text: root.outcome.result.summary.split("\n")[0] ?? "" }
          : { kind: "interrupted", text: "the session was closed before the root finished" },
      );
      publishStatus();
    },

    dispose: async () => {
      stopTimeline();
    },
  };
};
