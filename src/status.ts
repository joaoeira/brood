/**
 * Bounded operational projections. The supervisor feeds authoritative registry
 * state into these pure builders; neither raw outcomes nor controller internals
 * cross the public status boundary.
 */
import { Schema } from "effect";
import {
  AgentAdmissionCapacity,
  AgentId,
  AgentName,
  DependencyOutcome,
  type AgentStatus,
} from "./agent.js";
import { AgentActivity, type AgentActivity as AgentActivityType } from "./communication.js";
import { PublicModelProfile } from "./profiles.js";

export const SwarmRunState = Schema.Literals(["not_started", "running", "draining", "completed"]);
export type SwarmRunState = typeof SwarmRunState.Type;

export const OperationalAgentState = Schema.Literals([
  "starting",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
]);
export type OperationalAgentState = typeof OperationalAgentState.Type;

export const CoordinationCounts = Schema.Struct({
  unreadMessages: Schema.Natural,
  unreadUrgent: Schema.Natural,
  openRequestsIncoming: Schema.Natural,
  openRequestsOutgoing: Schema.Natural,
  pendingOperatorMessages: Schema.Natural,
  unseenBulletins: Schema.Natural,
});
export interface CoordinationCounts extends Schema.Schema.Type<typeof CoordinationCounts> {}

export interface StatusAgent {
  readonly path: string;
  readonly name: string;
  readonly state: OperationalAgentState;
  readonly durationMillis: number;
  readonly activity?: AgentActivityType;
  readonly waitTargets: ReadonlyArray<string>;
  /** Present only when at least one count is nonzero. Counts, never bodies. */
  readonly coordination?: CoordinationCounts;
  readonly children: ReadonlyArray<StatusAgent>;
}

export const StatusAgent = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  state: OperationalAgentState,
  durationMillis: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  activity: Schema.optionalKey(AgentActivity),
  waitTargets: Schema.Array(Schema.String),
  coordination: Schema.optionalKey(CoordinationCounts),
  children: Schema.Array(Schema.suspend((): Schema.Codec<StatusAgent> => StatusAgent)),
});

export const SwarmStatus = Schema.Struct({
  version: Schema.Literal(2),
  state: SwarmRunState,
  elapsedMillis: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  capacity: Schema.Struct({
    admissions: AgentAdmissionCapacity,
    runs: Schema.Struct({
      active: Schema.Natural,
      limit: Schema.Natural,
      available: Schema.Natural,
    }),
  }),
  counts: Schema.Struct({
    starting: Schema.Natural,
    queued: Schema.Natural,
    running: Schema.Natural,
    waiting: Schema.Natural,
    completed: Schema.Natural,
    failed: Schema.Natural,
    interrupted: Schema.Natural,
  }),
  agents: Schema.Array(StatusAgent),
});
export interface SwarmStatus extends Schema.Schema.Type<typeof SwarmStatus> {}

export const AgentDetail = Schema.Struct({
  version: Schema.Literal(2),
  path: Schema.String,
  id: AgentId,
  parentId: Schema.optionalKey(AgentId),
  parentPath: Schema.optionalKey(Schema.String),
  name: AgentName,
  state: OperationalAgentState,
  durationMillis: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  activity: Schema.optionalKey(AgentActivity),
  waitTargets: Schema.Array(Schema.String),
  coordination: Schema.optionalKey(CoordinationCounts),
  children: Schema.Array(Schema.String),
  profile: PublicModelProfile,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  terminalAt: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(DependencyOutcome),
});
export interface AgentDetail extends Schema.Schema.Type<typeof AgentDetail> {}

export type RunLifecycle =
  | { readonly state: "not_started" }
  | { readonly state: "running"; readonly startedAt: number }
  | { readonly state: "draining"; readonly startedAt: number }
  | { readonly state: "completed"; readonly startedAt: number; readonly finishedAt: number };

export interface StatusAgentSource {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly parentId?: AgentId;
  readonly profile: PublicModelProfile;
  readonly status: AgentStatus;
  readonly waitTargets: ReadonlyArray<AgentId>;
  readonly activity?: AgentActivityType;
  readonly coordination?: CoordinationCounts;
  readonly outcome?: DependencyOutcome;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt?: number;
}

/** Projects counts only when something is nonzero, keeping quiet agents quiet. */
const activeCoordination = (
  coordination: CoordinationCounts | undefined,
): CoordinationCounts | undefined =>
  coordination !== undefined &&
  coordination.unreadMessages +
    coordination.unreadUrgent +
    coordination.openRequestsIncoming +
    coordination.openRequestsOutgoing +
    coordination.pendingOperatorMessages +
    coordination.unseenBulletins >
    0
    ? coordination
    : undefined;

export interface StatusProjectionInput {
  readonly lifecycle: RunLifecycle;
  readonly now: number;
  /** Authoritative admission capacity from the same registry snapshot as `agents`. */
  readonly admissions: AgentAdmissionCapacity;
  readonly maxConcurrency: number;
  readonly activeRuns: number;
  readonly agents: ReadonlyArray<StatusAgentSource>;
}

export class StatusInvariantDefect extends Error {}

const operationalState = (status: AgentStatus): OperationalAgentState => {
  switch (status) {
    case "Starting":
      return "starting";
    case "Queued":
      return "queued";
    case "Running":
      return "running";
    case "Waiting":
      return "waiting";
    case "Completed":
      return "completed";
    case "Failed":
      return "failed";
    case "Interrupted":
      return "interrupted";
  }
};

const elapsedMillis = (lifecycle: RunLifecycle, now: number): number => {
  switch (lifecycle.state) {
    case "not_started":
      return 0;
    case "running":
    case "draining":
      return Math.max(0, now - lifecycle.startedAt);
    case "completed":
      return Math.max(0, lifecycle.finishedAt - lifecycle.startedAt);
  }
};

interface IndexedAgent {
  readonly source: StatusAgentSource;
  readonly path: string;
}

const findIndexedAgent = (
  indexed: ReadonlyMap<AgentId, IndexedAgent>,
  reference: string,
): IndexedAgent | undefined => {
  for (const candidate of indexed.values()) {
    if (candidate.source.id === reference || candidate.path === reference) return candidate;
  }
  return undefined;
};

const indexAgents = (
  agents: ReadonlyArray<StatusAgentSource>,
): ReadonlyMap<AgentId, IndexedAgent> => {
  const indexed = new Map<AgentId, IndexedAgent>();
  for (const agent of agents) {
    const parentPath = agent.parentId === undefined ? undefined : indexed.get(agent.parentId)?.path;
    if (agent.parentId !== undefined && parentPath === undefined) {
      throw new StatusInvariantDefect(`Agent ${agent.id} appears before its parent`);
    }
    indexed.set(agent.id, {
      source: agent,
      path: parentPath === undefined ? agent.name : `${parentPath}/${agent.name}`,
    });
  }
  return indexed;
};

const statusTree = (
  agents: ReadonlyArray<StatusAgentSource>,
  indexed: ReadonlyMap<AgentId, IndexedAgent>,
  now: number,
): ReadonlyArray<StatusAgent> => {
  const children = new Map<AgentId | undefined, Array<StatusAgentSource>>();
  for (const agent of agents) {
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }

  const build = (agent: StatusAgentSource): StatusAgent => {
    const indexedAgent = indexed.get(agent.id);
    if (indexedAgent === undefined) {
      throw new StatusInvariantDefect(`Agent ${agent.id} is missing from the status index`);
    }
    const coordination = activeCoordination(agent.coordination);
    return {
      path: indexedAgent.path,
      name: agent.name,
      state: operationalState(agent.status),
      durationMillis: Math.max(0, (agent.terminalAt ?? now) - agent.createdAt),
      ...(agent.activity === undefined ? {} : { activity: agent.activity }),
      ...(coordination === undefined ? {} : { coordination }),
      waitTargets: agent.waitTargets.map((targetId) => {
        const target = indexed.get(targetId);
        if (target === undefined) {
          throw new StatusInvariantDefect(
            `Wait target ${targetId} is missing from the status index`,
          );
        }
        return target.path;
      }),
      children: (children.get(agent.id) ?? []).map(build),
    };
  };

  return (children.get(undefined) ?? []).map(build);
};

export const buildSwarmStatus = (input: StatusProjectionInput): SwarmStatus => {
  const indexed = indexAgents(input.agents);
  const counts = {
    starting: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
  };
  for (const agent of input.agents) counts[operationalState(agent.status)] += 1;

  return {
    version: 2,
    state: input.lifecycle.state,
    elapsedMillis: elapsedMillis(input.lifecycle, input.now),
    capacity: {
      admissions: input.admissions,
      runs: {
        active: input.activeRuns,
        limit: input.maxConcurrency,
        available: Math.max(0, input.maxConcurrency - input.activeRuns),
      },
    },
    counts,
    agents: statusTree(input.agents, indexed, input.now),
  };
};

export const buildAgentDetail = (
  input: Pick<StatusProjectionInput, "agents" | "now">,
  reference: string,
): AgentDetail | undefined => {
  const indexed = indexAgents(input.agents);
  const selected = findIndexedAgent(indexed, reference);
  if (selected === undefined) return undefined;

  const agent = selected.source;
  const parent = agent.parentId === undefined ? undefined : indexed.get(agent.parentId);
  const coordination = activeCoordination(agent.coordination);
  return {
    version: 2,
    path: selected.path,
    id: agent.id,
    ...(agent.parentId === undefined ? {} : { parentId: agent.parentId }),
    ...(parent === undefined ? {} : { parentPath: parent.path }),
    name: agent.name,
    state: operationalState(agent.status),
    durationMillis: Math.max(0, (agent.terminalAt ?? input.now) - agent.createdAt),
    ...(agent.activity === undefined ? {} : { activity: agent.activity }),
    ...(coordination === undefined ? {} : { coordination }),
    waitTargets: agent.waitTargets.map((targetId) => {
      const target = indexed.get(targetId);
      if (target === undefined) {
        throw new StatusInvariantDefect(`Wait target ${targetId} is missing from the status index`);
      }
      return target.path;
    }),
    children: input.agents
      .flatMap((candidate) => (candidate.parentId === agent.id ? [indexed.get(candidate.id)] : []))
      .map((child) => {
        if (child === undefined) {
          throw new StatusInvariantDefect(`A child of ${agent.id} is missing from the index`);
        }
        return child.path;
      }),
    profile: agent.profile,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.terminalAt === undefined ? {} : { terminalAt: agent.terminalAt }),
    ...(agent.outcome === undefined ? {} : { outcome: agent.outcome }),
  };
};

export const resolveAgentReference = (
  agents: ReadonlyArray<StatusAgentSource>,
  reference: string,
): AgentId | undefined => findIndexedAgent(indexAgents(agents), reference)?.source.id;

export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  if (milliseconds < 3_600_000) {
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1_000);
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
};

const formatCoordination = (counts: CoordinationCounts): string => {
  const parts: Array<string> = [];
  if (counts.unreadMessages > 0) {
    const urgent = counts.unreadUrgent > 0 ? ` (${counts.unreadUrgent} urgent)` : "";
    parts.push(`mail ${counts.unreadMessages}${urgent}`);
  }
  if (counts.openRequestsIncoming > 0) parts.push(`owes ${counts.openRequestsIncoming}`);
  if (counts.openRequestsOutgoing > 0) parts.push(`awaits ${counts.openRequestsOutgoing}`);
  if (counts.pendingOperatorMessages > 0) parts.push(`operator ${counts.pendingOperatorMessages}`);
  if (counts.unseenBulletins > 0) parts.push(`bulletins ${counts.unseenBulletins}`);
  return parts.join(" · ");
};

const renderStatusAgent = (
  agent: StatusAgent,
  prefix: string,
  connector: string,
  isLast: boolean,
): ReadonlyArray<string> => {
  const waitSuffix = agent.waitTargets.length === 0 ? "" : `  → ${agent.waitTargets.join(", ")}`;
  const coordinationSuffix =
    agent.coordination === undefined ? "" : `  [${formatCoordination(agent.coordination)}]`;
  const line = `${prefix}${connector}${agent.path}  ${agent.state}  ${formatDuration(agent.durationMillis)}${waitSuffix}${coordinationSuffix}`;
  const childPrefix = connector === "" ? prefix : `${prefix}${isLast ? "   " : "│  "}`;
  return [
    line,
    ...(agent.activity === undefined ? [] : [`${childPrefix}   ${agent.activity}`]),
    ...agent.children.flatMap((child, index) =>
      renderStatusAgent(
        child,
        childPrefix,
        index === agent.children.length - 1 ? "└─ " : "├─ ",
        index === agent.children.length - 1,
      ),
    ),
  ];
};

export const formatSwarmStatus = (status: SwarmStatus): string => {
  const { admissions, runs } = status.capacity;
  const counts = status.counts;
  const lines = [
    `${status.state.toUpperCase()}  ${formatDuration(status.elapsedMillis)}`,
    `Admissions ${admissions.used}/${admissions.limit} (${admissions.remaining} remaining)  Active runs ${runs.active}/${runs.limit} (${runs.available} available)`,
    `States starting ${counts.starting} · queued ${counts.queued} · running ${counts.running} · waiting ${counts.waiting} · completed ${counts.completed} · failed ${counts.failed} · interrupted ${counts.interrupted}`,
    "Swarm",
  ];
  if (status.agents.length === 0) lines.push("(no agents admitted)");
  for (const root of status.agents) lines.push(...renderStatusAgent(root, "", "", true));
  return lines.join("\n");
};

const formatTimestamp = (timestamp: number): string => new Date(timestamp).toISOString();

export const formatAgentDetail = (detail: AgentDetail): string => {
  const lines = [
    `${detail.path}  ${detail.state}  ${formatDuration(detail.durationMillis)}`,
    `ID ${detail.id}`,
    `Profile ${detail.profile.name} (${detail.profile.provider}/${detail.profile.model}, thinking ${detail.profile.thinkingLevel})`,
    `Created ${formatTimestamp(detail.createdAt)}`,
    `Updated ${formatTimestamp(detail.updatedAt)}`,
  ];
  if (detail.parentPath !== undefined) lines.push(`Parent ${detail.parentPath}`);
  if (detail.activity !== undefined) lines.push(`Activity ${detail.activity}`);
  if (detail.coordination !== undefined) {
    lines.push(`Comms ${formatCoordination(detail.coordination)}`);
  }
  if (detail.terminalAt !== undefined) lines.push(`Finished ${formatTimestamp(detail.terminalAt)}`);
  if (detail.waitTargets.length > 0) lines.push(`Waiting on ${detail.waitTargets.join(", ")}`);
  if (detail.children.length > 0) lines.push(`Children ${detail.children.join(", ")}`);
  if (detail.outcome !== undefined) {
    switch (detail.outcome._tag) {
      case "Completed":
        lines.push("Outcome completed");
        lines.push(`Summary ${detail.outcome.result.summary}`);
        lines.push(`Session ${detail.outcome.result.sessionId}`);
        if (detail.outcome.result.truncated) {
          lines.push(
            `Summary truncated from ${detail.outcome.result.originalCharacterCount} characters`,
          );
        }
        break;
      case "Failed":
        lines.push(`Outcome failed (${detail.outcome.code})`);
        lines.push(`Failure ${detail.outcome.message}`);
        break;
      case "Interrupted":
        lines.push(`Outcome interrupted (${detail.outcome.reason})`);
        break;
    }
  }
  return lines.join("\n");
};
