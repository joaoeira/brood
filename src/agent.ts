/**
 * Shared Brood vocabulary: identifiers, agent outcomes, lifecycle state, and
 * every error the system can fail with.
 *
 * This is the leaf module — it imports nothing else from src/, and every other
 * module builds on it. Turn control lives in control.ts, model profiles in
 * profiles.ts, and model-facing text in render.ts.
 */
import { Cause, Schema } from "effect";

// ── Identifiers ─────────────────────────────────────────────────────────────

const modelFriendlyName = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const opaqueAgentId = Schema.isPattern(/^agent_[A-Za-z0-9_-]+$/);
const opaqueWaitId = Schema.isPattern(/^wait_[A-Za-z0-9_-]+$/);
const opaqueBatchId = Schema.isPattern(/^batch_[A-Za-z0-9_-]+$/);

export const AgentId = Schema.String.check(opaqueAgentId, Schema.isMaxLength(80)).pipe(
  Schema.brand("AgentId"),
);
export type AgentId = typeof AgentId.Type;
export const makeAgentId = Schema.decodeUnknownSync(AgentId);
export const decodeAgentId = Schema.decodeUnknownEffect(AgentId);

export const WaitId = Schema.String.check(opaqueWaitId, Schema.isMaxLength(80)).pipe(
  Schema.brand("WaitId"),
);
export type WaitId = typeof WaitId.Type;
export const makeWaitId = Schema.decodeUnknownSync(WaitId);

export const BatchId = Schema.String.check(opaqueBatchId, Schema.isMaxLength(80)).pipe(
  Schema.brand("BatchId"),
);
export type BatchId = typeof BatchId.Type;
export const makeBatchId = Schema.decodeUnknownSync(BatchId);

export const ToolInvocationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
).pipe(Schema.brand("ToolInvocationId"));
export type ToolInvocationId = typeof ToolInvocationId.Type;
export const makeToolInvocationId = Schema.decodeUnknownSync(ToolInvocationId);

export const AgentName = Schema.Trim.check(modelFriendlyName).pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;
export const makeAgentName = Schema.decodeUnknownSync(AgentName);
export const decodeAgentName = Schema.decodeUnknownEffect(AgentName);

export const ProfileName = Schema.String.check(modelFriendlyName).pipe(Schema.brand("ProfileName"));
export type ProfileName = typeof ProfileName.Type;
export const makeProfileName = Schema.decodeUnknownSync(ProfileName);
export const decodeProfileName = Schema.decodeUnknownEffect(ProfileName);

// Non-empty trimmed text for delegated child goals at the tool boundary.
// Run-request goals are normalized exactly once by main.ts's normalizeRunRequest.
const Goal = Schema.Trim.check(Schema.isMinLength(1));

// ── Agent outcomes ──────────────────────────────────────────────────────────

export const AgentResult = Schema.Struct({
  agentId: AgentId,
  sessionId: Schema.String,
  summary: Schema.String,
  truncated: Schema.Boolean,
  originalCharacterCount: Schema.Natural,
});
export interface AgentResult extends Schema.Schema.Type<typeof AgentResult> {}

export const DependencyOutcome = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Completed"),
    agentId: AgentId,
    name: AgentName,
    result: AgentResult,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    agentId: AgentId,
    name: AgentName,
    code: Schema.String.check(Schema.isMaxLength(64)),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Interrupted"),
    agentId: AgentId,
    name: AgentName,
    reason: Schema.String.check(Schema.isMaxLength(64)),
  }),
]);
export type DependencyOutcome = typeof DependencyOutcome.Type;

export const InterruptReason = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("OperatorRequested"),
    source: Schema.Literals(["cli", "api"]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("DrainTimeout"),
    timeoutMillis: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ _tag: Schema.Literal("SupervisorShutdown") }),
]);
export type InterruptReason = typeof InterruptReason.Type;

// Internal composition export: carries a raw Cause, so it must never be
// re-exported from index.ts. The public projection is AgentFailureSummary.
export type AgentFailure =
  | { readonly _tag: "AgentStartFailed"; readonly error: PiOpenError }
  | { readonly _tag: "AgentRunFailed"; readonly error: PiRunError }
  | { readonly _tag: "AgentProtocolFailed"; readonly error: PiProtocolError }
  | { readonly _tag: "AgentDefect"; readonly cause: Cause.Cause<unknown> };

export type AgentOutcome =
  | { readonly _tag: "Completed"; readonly result: AgentResult }
  | { readonly _tag: "Failed"; readonly failure: AgentFailure }
  | { readonly _tag: "Interrupted"; readonly reason: InterruptReason };

export type AgentStatus =
  | "Queued"
  | "Starting"
  | "Running"
  | "Waiting"
  | "Completed"
  | "Failed"
  | "Interrupted";

export const AgentFailureSummary = Schema.Struct({
  code: Schema.Literals([
    "AgentStartFailed",
    "AgentRunFailed",
    "AgentProtocolFailed",
    "AgentDefect",
  ]),
  message: Schema.String,
});
export type AgentFailureSummary = typeof AgentFailureSummary.Type;

export const DrainReport = Schema.Struct({
  timedOut: Schema.Boolean,
  interruptedAgentIds: Schema.Array(AgentId),
  terminalAgentCount: Schema.Natural,
});
export interface DrainReport extends Schema.Schema.Type<typeof DrainReport> {}

export const BroodResult = Schema.Struct({
  root: AgentResult,
  drain: DrainReport,
});
export interface BroodResult extends Schema.Schema.Type<typeof BroodResult> {}

// ── Admission capacity and the run request ──────────────────────────────────
// Admission is cumulative: an admitted agent — running, waiting, or terminal —
// never returns its admission during the run. `used` is monotonic, so a stale
// snapshot can only overstate what remains.

// Internal composition export: shared with runtime.ts's config bounds so the
// positive-integer rule has one definition; deliberately not in index.ts.
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const AgentAdmissionCapacity = Schema.Struct({
  limit: PositiveInt,
  used: Schema.Natural,
  remaining: Schema.Natural,
}).check(
  Schema.makeFilter((capacity) =>
    capacity.used <= capacity.limit && capacity.remaining === capacity.limit - capacity.used
      ? undefined
      : "admission capacity must satisfy remaining = limit - used",
  ),
);
export interface AgentAdmissionCapacity extends Schema.Schema.Type<typeof AgentAdmissionCapacity> {}

// Type source for the public request shape. Structural enforcement is
// TypeScript's job in this private package — nothing decodes with this schema
// today; semantic validation lives in main.ts's normalizeRunRequest.
export const BroodRunRequestInput = Schema.Struct({
  goal: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
});
export type BroodRunRequestEncoded = typeof BroodRunRequestInput.Encoded;

export interface BroodRunRequest {
  readonly goal: string;
  readonly instructions?: string;
}

// ── Control protocol ────────────────────────────────────────────────────────
// Transcript-visible details for the two lifecycle-control tools. The Pi
// adapter decodes them alongside communication markers without importing tool
// implementations.

export const BroodControl = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("suspend"),
    invocationId: ToolInvocationId,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("continue"),
    invocationId: ToolInvocationId,
  }),
]);
export type BroodControl = typeof BroodControl.Type;
export const decodeBroodControl = Schema.decodeUnknownEffect(BroodControl);

export const DelegatedTask = Schema.Struct({
  name: AgentName,
  goal: Goal,
  profile: Schema.optionalKey(ProfileName),
});
export interface DelegatedTask extends Schema.Schema.Type<typeof DelegatedTask> {}

const DelegatedAgent = Schema.Struct({
  name: AgentName,
  id: AgentId,
  profile: ProfileName,
});

export const DelegateToolDetails = Schema.Struct({
  version: Schema.Literal(2),
  batchId: BatchId,
  agents: Schema.Array(DelegatedAgent),
  admissions: AgentAdmissionCapacity,
  broodControl: BroodControl,
});
export interface DelegateToolDetails extends Schema.Schema.Type<typeof DelegateToolDetails> {}

export const WaitToolDetails = Schema.Struct({
  version: Schema.Literal(1),
  outcomes: Schema.Array(DependencyOutcome),
  broodControl: BroodControl,
});
export interface WaitToolDetails extends Schema.Schema.Type<typeof WaitToolDetails> {}

// ── Errors ──────────────────────────────────────────────────────────────────
// Every way Brood can fail, in one place. Schema.TaggedError because each of
// these crosses a tool, monitoring, or public application boundary.

const BROOD_CONFIG_ERROR_REASONS = [
  "DecodeFailed",
  "InvalidField",
  "ProfileReferenceNotFound",
  "UnknownConfiguredModel",
  "UnsupportedThinkingLevel",
  "ProfileHelpTooLarge",
  "ModelRuntimeInitializationFailed",
] as const;
// Internal composition export for the catalogue compiler in profiles.ts; not
// part of the public surface — consumers match on BroodConfigError itself.
export type BroodConfigErrorReason = (typeof BROOD_CONFIG_ERROR_REASONS)[number];

export class BroodConfigError extends Schema.TaggedError<BroodConfigError>()("BroodConfigError", {
  stage: Schema.Literals(["decode", "compile"]),
  reason: Schema.Literals(BROOD_CONFIG_ERROR_REASONS),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
}) {}

export class PiOpenError extends Schema.TaggedError<PiOpenError>()("PiOpenError", {
  agentId: AgentId,
  message: Schema.String,
}) {}

export class PiRunError extends Schema.TaggedError<PiRunError>()("PiRunError", {
  agentId: AgentId,
  message: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
}) {}

export class PiProtocolError extends Schema.TaggedError<PiProtocolError>()("PiProtocolError", {
  agentId: AgentId,
  message: Schema.String,
}) {}

export class DelegateRejected extends Schema.TaggedError<DelegateRejected>()("DelegateRejected", {
  reason: Schema.Literals([
    "InvalidInput",
    "NameCollision",
    "PathTooLong",
    "NotAccepting",
    "UnknownProfile",
    "DuplicateInvocationId",
  ]),
  message: Schema.String,
}) {}

// Internal composition export: crosses the registry-to-tool boundary with
// quantitative fields; not re-exported from index.ts while no public API
// exposes direct delegation.
export class AgentAdmissionLimitExceeded extends Schema.TaggedError<AgentAdmissionLimitExceeded>()(
  "AgentAdmissionLimitExceeded",
  {
    requested: PositiveInt,
    capacity: AgentAdmissionCapacity,
  },
) {
  get message(): string {
    const remaining = this.capacity.remaining;
    const next =
      remaining === 0
        ? "Continue without delegation."
        : `Re-plan with at most ${remaining} task${remaining === 1 ? "" : "s"}, or continue directly.`;
    return `Requested ${this.requested} agent admissions, but only ${remaining} of ${this.capacity.limit} remain; no agents were created. ${next}`;
  }
}

/** The delegation error channel named by the admission proposal (§10). */
export type DelegateError = DelegateRejected | AgentAdmissionLimitExceeded;

export class WaitRejected extends Schema.TaggedError<WaitRejected>()("WaitRejected", {
  reason: Schema.Literals([
    "InvalidInput",
    "EmptySelection",
    "UnknownChild",
    "DuplicateInvocationId",
  ]),
  message: Schema.String,
}) {}

export class UnknownAgent extends Schema.TaggedError<UnknownAgent>()("UnknownAgent", {
  agentId: AgentId,
}) {
  get message(): string {
    return `Unknown agent: ${this.agentId}`;
  }
}

export class UnknownAgentReference extends Schema.TaggedError<UnknownAgentReference>()(
  "UnknownAgentReference",
  { reference: Schema.String },
) {
  get message(): string {
    return `Unknown agent reference: ${this.reference}`;
  }
}

export class RootStartError extends Schema.TaggedError<RootStartError>()("RootStartError", {
  reason: Schema.Literals(["InvalidGoal", "InvalidInstructions", "AlreadyStarted"]),
  message: Schema.String,
}) {}

export class AgentFailed extends Schema.TaggedError<AgentFailed>()("AgentFailed", {
  failure: AgentFailureSummary,
  drain: DrainReport,
}) {}

export class RootInterrupted extends Schema.TaggedError<RootInterrupted>()("RootInterrupted", {
  reason: InterruptReason,
  drain: DrainReport,
}) {}
