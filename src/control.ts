/**
 * Turn-control vocabulary shared by the registry, Pi adapter, renderer, and
 * supervisor. Transcript payload schemas remain in their leaf vocabulary
 * modules; this module composes them into Brood's command state machine.
 */
import { Schema } from "effect";
import { DependencyOutcome, ToolInvocationId, WaitId } from "./agent.js";
import { PeerRequestOutcome, RequestId } from "./communication.js";

export const SuspensionMarker = Schema.TaggedUnion({
  AgentWait: {
    tool: Schema.Literals(["delegate", "wait_for_agents"]),
    invocationId: ToolInvocationId,
  },
  RequestWait: {
    tool: Schema.Literal("ask_agent"),
    invocationId: ToolInvocationId,
    request: RequestId,
  },
});
export type SuspensionMarker = typeof SuspensionMarker.Type;
export const decodeSuspensionMarker = (input: unknown) =>
  Schema.decodeUnknownEffect(SuspensionMarker, { onExcessProperty: "error" })(input);

export interface PiRunResult {
  readonly finalText: string;
  readonly finalMessageId: string | undefined;
  readonly stopReason: "stop";
}

export type PiRunOutcome =
  | { readonly _tag: "Completed"; readonly result: PiRunResult }
  | {
      readonly _tag: "Suspended";
      readonly markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>];
    };

export const CoordinationNotice = Schema.Struct({
  unreadMessages: Schema.Natural,
  openRequests: Schema.Natural,
  unseenBulletins: Schema.Natural,
});
export interface CoordinationNotice extends Schema.Schema.Type<typeof CoordinationNotice> {}

export const ActiveWaitCounts = Schema.Struct({
  agentCompletions: Schema.Natural,
  replies: Schema.Natural,
});
export interface ActiveWaitCounts extends Schema.Schema.Type<typeof ActiveWaitCounts> {}

export const AgentCommand = Schema.TaggedUnion({
  InitialGoal: {
    goal: Schema.String,
    notice: Schema.optionalKey(CoordinationNotice),
  },
  WaitSatisfied: {
    waitId: WaitId,
    dependencies: Schema.Array(DependencyOutcome),
    requests: Schema.Array(PeerRequestOutcome),
    notice: Schema.optionalKey(CoordinationNotice),
  },
  CoordinationWake: {
    notice: CoordinationNotice,
    waitingFor: ActiveWaitCounts,
  },
});
export type AgentCommand = typeof AgentCommand.Type;
