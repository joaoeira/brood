/**
 * The single seam between the TUI and the Brood core. Every other module in
 * this package imports Brood types and constructors from here, so the relative
 * depth of `../../src` — and the decision about what counts as public API —
 * lives in exactly one file.
 */
export {
  AgentFailed,
  AgentId,
  ProfileName,
  RootInterrupted,
  RootStartError,
  UnknownAgentReference,
  makeBroodApplicationFromUnknown,
} from "../../src/index.js";

export { AgentName, BatchId, ToolInvocationId, WaitId } from "../../src/agent.js";
export { AgentPath, RequestId } from "../../src/communication.js";
export type { PiSessionEvent } from "../../src/pi-adapter.js";
export type { SupervisorLifecycleEvent } from "../../src/supervisor.js";

export type {
  AgentDetail,
  BroodApplication,
  BroodController,
  BroodResult,
  BulletinView,
  StatusAgent,
  SupervisorEvent,
  SwarmStatus,
  TrafficView,
} from "../../src/index.js";

import type { StatusAgent, SupervisorEvent } from "../../src/index.js";

/** The lifecycle half of the event stream: everything the supervisor itself emits. */
export type LifecycleEvent = Extract<SupervisorEvent, { source: "supervisor" }>;

/** The Pi half: per-session turn and tool telemetry, keyed by agent id. */
export type PiEvent = Extract<SupervisorEvent, { source: "pi" }>["event"];

/** The seven operational states an agent can report. */
export type AgentState = StatusAgent["state"];
