/**
 * Turn-control vocabulary shared by the registry, Pi adapter, renderer, and
 * supervisor. Transcript payload schemas remain in their leaf vocabulary
 * modules; this module composes them into Brood's command state machine.
 */
import { Schema } from "effect";
import { DependencyOutcome, ToolInvocationId, WaitId } from "./agent.js";
import { AgentWaitCounts, PeerRequestOutcome, RequestId } from "./communication.js";

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
  | {
      readonly _tag: "Completed";
      readonly result: PiRunResult;
      /** Operator messages the adapter observed being injected during this run. */
      readonly deliveredOperatorMessages?: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Suspended";
      readonly markers: readonly [SuspensionMarker, ...ReadonlyArray<SuspensionMarker>];
      readonly deliveredOperatorMessages?: ReadonlyArray<string>;
    };

export const CoordinationNotice = Schema.Struct({
  unreadMessages: Schema.Natural,
  openRequests: Schema.Natural,
  unseenBulletins: Schema.Natural,
});
export interface CoordinationNotice extends Schema.Schema.Type<typeof CoordinationNotice> {}

// `operatorMessage` is one normalized operator-authored body drained from the
// registry: at most one per command, so the resume budget can always reserve
// space for it whole. Remaining pending messages trigger further commands.
export const AgentCommand = Schema.TaggedUnion({
  InitialGoal: {
    goal: Schema.String,
    operatorMessage: Schema.optionalKey(Schema.String),
    notice: Schema.optionalKey(CoordinationNotice),
  },
  WaitSatisfied: {
    waitId: WaitId,
    dependencies: Schema.Array(DependencyOutcome),
    requests: Schema.Array(PeerRequestOutcome),
    operatorMessage: Schema.optionalKey(Schema.String),
    notice: Schema.optionalKey(CoordinationNotice),
  },
  CoordinationWake: {
    notice: CoordinationNotice,
    waitingFor: AgentWaitCounts,
    operatorMessage: Schema.optionalKey(Schema.String),
  },
});
export type AgentCommand = typeof AgentCommand.Type;
