/**
 * The whole application state, held outside React and published through
 * `useSyncExternalStore`. Bridges are plain callers: they push snapshots and
 * events in, components read state out, and nothing in between needs a React
 * context. Event translation (ids to paths, tool pairing, ticker phrasing)
 * lives here so both the live and demo bridges get it for free.
 */
import { useSyncExternalStore } from "react";
import type {
  AgentDetail,
  BulletinView,
  LifecycleEvent,
  PiEvent,
  StatusAgent,
  SupervisorEvent,
  SwarmStatus,
} from "./brood";

const TICKER_CAPACITY = 250;
const RECENT_TOOLS_PER_AGENT = 30;

export type Tone = "muted" | "info" | "warn" | "error";

export interface TickerEntry {
  readonly at: number;
  readonly text: string;
  readonly tone: Tone;
}

/** A tool call in flight or finished, paired from ToolStart/ToolEnd by call id. */
export interface ToolEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly isError?: boolean | undefined;
}

export interface RunOutcome {
  readonly kind: "completed" | "failed" | "interrupted";
  readonly text: string;
}

export type Overlay =
  | "none"
  | "bulletins"
  | "transcript"
  | "compose"
  | { readonly kind: "confirm-interrupt" | "confirm-quit" };

export interface AppState {
  readonly phase: "launch" | "monitor";
  readonly goalDraft: string;
  readonly instructionsPath: string;
  readonly launchError?: string | undefined;
  readonly status?: SwarmStatus | undefined;
  readonly runOutcome?: RunOutcome | undefined;
  readonly selection?: string | undefined;
  readonly detail?: AgentDetail | undefined;
  readonly idToPath: ReadonlyMap<string, string>;
  readonly ticker: ReadonlyArray<TickerEntry>;
  readonly recentTools: ReadonlyMap<string, ReadonlyArray<ToolEvent>>;
  readonly bulletins: ReadonlyArray<BulletinView>;
  /** Highest bulletin sequence the operator has had on screen; drives the hint-bar marker. */
  readonly seenBulletinSequence: number;
  readonly overlay: Overlay;
  readonly quitting: boolean;
}

const initialState: AppState = {
  phase: "launch",
  goalDraft: "",
  instructionsPath: "",
  idToPath: new Map(),
  ticker: [],
  recentTools: new Map(),
  bulletins: [],
  seenBulletinSequence: 0,
  overlay: "none",
  quitting: false,
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

const commit = (next: AppState): void => {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
};

const patch = (changes: Partial<AppState>): void => commit({ ...state, ...changes });

const appended = <T>(list: ReadonlyArray<T>, entry: T, capacity: number): ReadonlyArray<T> => {
  const next = [...list, entry];
  return next.length <= capacity ? next : next.slice(next.length - capacity);
};

const pushTicker = (at: number, text: string, tone: Tone): void => {
  patch({ ticker: appended(state.ticker, { at, text, tone }, TICKER_CAPACITY) });
};

/** Falls back to the raw id so an event that outruns its AgentRegistered still reads sensibly. */
const pathOf = (agentId: string): string => state.idToPath.get(agentId) ?? agentId;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const registerAgent = (event: Extract<LifecycleEvent, { type: "AgentRegistered" }>): string => {
  const parentPath = event.parentId === undefined ? undefined : state.idToPath.get(event.parentId);
  const path = parentPath === undefined ? event.name : `${parentPath}/${event.name}`;
  const idToPath = new Map(state.idToPath);
  idToPath.set(event.agentId, path);
  patch({ idToPath });
  return path;
};

/**
 * Ticker copy for one lifecycle event, or `undefined` for events that are real
 * but too noisy to narrate. AgentStatusChanged is the main one: it fires on
 * every transition and the tree already shows the result.
 */
const describeLifecycle = (
  event: LifecycleEvent,
): { readonly text: string; readonly tone: Tone } | undefined => {
  switch (event.type) {
    case "AgentRegistered":
      return { text: `${pathOf(event.agentId)}  registered`, tone: "muted" };
    case "AgentSettled":
      return {
        text: `${pathOf(event.agentId)}  settled ${event.status}`,
        tone:
          event.status === "Failed" ? "error" : event.status === "Interrupted" ? "warn" : "info",
      };
    case "AgentInterruptRequested":
      return { text: `${pathOf(event.agentId)}  interrupt requested`, tone: "warn" };
    case "AgentStatusChanged":
      return undefined;
    case "BatchAdmitted":
      return {
        text: `${pathOf(event.parentId)}  admitted ${plural(event.agentIds.length, "agent")}`,
        tone: "info",
      };
    case "WaitPlanned":
      return {
        text: `${pathOf(event.parentId)}  wait planned on ${plural(event.targetIds.length, "target")}`,
        tone: "muted",
      };
    case "AgentSuspended":
      return {
        text: `${pathOf(event.agentId)}  suspended on ${event.targetIds.map(pathOf).join(", ")}`,
        tone: "muted",
      };
    case "AgentResumed":
      return { text: `${pathOf(event.agentId)}  resumed`, tone: "muted" };
    case "MessageAccepted":
      return event.urgent
        ? { text: `${pathOf(event.fromId)} → ${event.toPath}  urgent message`, tone: "warn" }
        : { text: `${pathOf(event.fromId)} → ${event.toPath}  message`, tone: "muted" };
    case "RequestOpened":
      return { text: `${pathOf(event.fromId)} → ${event.toPath}  question opened`, tone: "info" };
    case "RequestReplied":
      return { text: `${pathOf(event.byId)} → ${event.toPath}  question answered`, tone: "info" };
    case "BulletinPosted":
      return { text: `${pathOf(event.authorId)}  bulletin posted`, tone: "info" };
    case "OperatorMessageAccepted":
      return { text: `operator → ${pathOf(event.toId)}  message`, tone: "info" };
    case "DrainStarted":
      return { text: "drain started", tone: "warn" };
    case "DrainTimedOut":
      return {
        text: `drain timed out after ${event.timeoutMillis}ms — interrupted ${plural(event.interruptedAgentIds.length, "agent")}`,
        tone: "error",
      };
    case "DrainCompleted":
      return {
        text: `drain completed — ${plural(event.report.terminalAgentCount, "terminal agent")}`,
        tone: "info",
      };
  }
};

const recordToolEvent = (event: PiEvent): void => {
  const { toolCallId, toolName } = event;
  if (toolCallId === undefined) return;
  const existing = state.recentTools.get(event.agentId) ?? [];
  const next =
    event.type === "ToolStart"
      ? appended(
          existing,
          { toolCallId, toolName: toolName ?? "tool", startedAt: Date.now() },
          RECENT_TOOLS_PER_AGENT,
        )
      : existing.map((entry) =>
          entry.toolCallId === toolCallId
            ? { ...entry, endedAt: Date.now(), isError: event.isError === true }
            : entry,
        );
  const recentTools = new Map(state.recentTools);
  recentTools.set(event.agentId, next);
  patch({ recentTools });
};

export const store = {
  getSnapshot: (): AppState => state,

  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Test/entry-point seam: lets index.tsx seed drafts before the first render. */
  reset: (overrides: Partial<AppState> = {}): void => {
    commit({ ...initialState, ...overrides });
  },

  setGoalDraft: (goalDraft: string): void => patch({ goalDraft }),
  setInstructionsPath: (instructionsPath: string): void => patch({ instructionsPath }),
  setLaunchError: (launchError: string | undefined): void => patch({ launchError }),
  setPhase: (phase: AppState["phase"]): void => patch({ phase, launchError: undefined }),
  setOverlay: (overlay: Overlay): void => patch({ overlay }),
  setQuitting: (quitting: boolean): void => patch({ quitting }),
  setStatus: (status: SwarmStatus): void => patch({ status }),
  setDetail: (detail: AgentDetail | undefined): void => patch({ detail }),
  setBulletins: (bulletins: ReadonlyArray<BulletinView>): void => patch({ bulletins }),

  /** Viewing the board is what marks it read; eviction can only shrink the count. */
  markBulletinsSeen: (): void => {
    const latest = state.bulletins.reduce(
      (max, post) => Math.max(max, post.sequence),
      state.seenBulletinSequence,
    );
    if (latest !== state.seenBulletinSequence) patch({ seenBulletinSequence: latest });
  },

  setSelection: (selection: string | undefined): void => {
    if (selection === state.selection) return;
    patch({ selection, detail: undefined });
  },

  setRunOutcome: (runOutcome: RunOutcome): void => {
    patch({ runOutcome });
    pushTicker(
      Date.now(),
      `run ${runOutcome.kind}`,
      runOutcome.kind === "failed" ? "error" : "info",
    );
  },

  note: (text: string, tone: Tone = "muted"): void => pushTicker(Date.now(), text, tone),

  onEvent: (event: SupervisorEvent): void => {
    if (event.source === "pi") {
      const piEvent = event.event;
      if (piEvent.type !== "ToolStart" && piEvent.type !== "ToolEnd") return;
      recordToolEvent(piEvent);
      if (piEvent.type === "ToolEnd" && piEvent.isError === true) {
        pushTicker(
          event.timestamp,
          `${pathOf(piEvent.agentId)}  ${piEvent.toolName ?? "tool"} failed`,
          "error",
        );
      }
      return;
    }
    if (event.type === "AgentRegistered") registerAgent(event);
    const described = describeLifecycle(event);
    if (described !== undefined) pushTicker(event.timestamp, described.text, described.tone);
  },
};

export const useAppState = (): AppState => useSyncExternalStore(store.subscribe, store.getSnapshot);

export const unseenBulletins = (current: AppState): number =>
  current.bulletins.filter((post) => post.sequence > current.seenBulletinSequence).length;

export interface FlatAgent {
  readonly agent: StatusAgent;
  readonly depth: number;
  /** Pre-rendered tree gutter: ancestor bars plus this row's own connector. */
  readonly prefix: string;
}

/** Depth-first flatten of the status tree, with box-drawing connectors baked in. */
export const flattenAgents = (
  agents: ReadonlyArray<StatusAgent>,
  connectors: ReadonlyArray<string> = [],
): ReadonlyArray<FlatAgent> =>
  agents.flatMap((agent, index) => {
    const isLast = index === agents.length - 1;
    const own = connectors.length === 0 ? "" : isLast ? "└─" : "├─";
    const row: FlatAgent = {
      agent,
      depth: connectors.length,
      prefix: connectors.join("") + own,
    };
    const childConnectors = connectors.length === 0 ? [""] : [...connectors, isLast ? "  " : "│ "];
    return [row, ...flattenAgents(agent.children, childConnectors)];
  });
