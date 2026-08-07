import type { Api, Model, ModelThinkingLevel as PiModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Cause, Data, Effect, HashMap, Option, Schema } from "effect";

const modelFriendlyName = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const opaqueAgentId = Schema.isPattern(/^agent_[A-Za-z0-9_-]+$/);
const opaqueWaitId = Schema.isPattern(/^wait_[A-Za-z0-9_-]+$/);
const opaqueBatchId = Schema.isPattern(/^batch_[A-Za-z0-9_-]+$/);

export const AgentId = Schema.String.check(opaqueAgentId, Schema.isMaxLength(80)).pipe(
  Schema.brand("AgentId"),
);
export type AgentId = typeof AgentId.Type;

export const makeAgentId = Schema.decodeUnknownSync(AgentId);

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

export const AgentName = Schema.Trim.check(modelFriendlyName).pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;
export const makeAgentName = Schema.decodeUnknownSync(AgentName);

export const ProfileName = Schema.String.check(modelFriendlyName).pipe(Schema.brand("ProfileName"));
export type ProfileName = typeof ProfileName.Type;
export const makeProfileName = Schema.decodeUnknownSync(ProfileName);

export const decodeAgentName = Schema.decodeUnknownEffect(AgentName);
export const decodeProfileName = Schema.decodeUnknownEffect(ProfileName);

export const DelegatedTask = Schema.Struct({
  name: AgentName,
  goal: Schema.Trim.check(Schema.isMinLength(1)),
  profile: Schema.optionalKey(ProfileName),
});
export interface DelegatedTask extends Schema.Schema.Type<typeof DelegatedTask> {}

export type ModelThinkingLevel = PiModelThinkingLevel;

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ModelThinkingLevel>;

type AssertNever<T extends never> = T;
type MissingThinkingLevels = AssertNever<
  Exclude<ModelThinkingLevel, (typeof THINKING_LEVELS)[number]>
>;
const noMissingThinkingLevels: MissingThinkingLevels | undefined = undefined;
void noMissingThinkingLevels;

const exhaustiveThinkingLevels: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
void exhaustiveThinkingLevels;

export const ModelThinkingLevel = Schema.Literals(THINKING_LEVELS);

export const ModelProfile = Schema.Struct({
  description: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  thinkingLevel: Schema.optionalKey(ModelThinkingLevel),
});
export interface ModelProfile extends Schema.Schema.Type<typeof ModelProfile> {}

export const ProfilesConfigInput = Schema.Struct({
  defaultProfile: Schema.String,
  rootProfile: Schema.optionalKey(Schema.String),
  profiles: Schema.Record(Schema.String, ModelProfile),
});
export interface ProfilesConfigInput extends Schema.Schema.Type<typeof ProfilesConfigInput> {}

export type BroodConfigErrorReason =
  | "DecodeFailed"
  | "InvalidField"
  | "ProfileReferenceNotFound"
  | "UnknownConfiguredModel"
  | "UnsupportedThinkingLevel"
  | "ProfileHelpTooLarge"
  | "ModelRuntimeInitializationFailed";

export class BroodConfigError extends Schema.TaggedError<BroodConfigError>()("BroodConfigError", {
  stage: Schema.Literals(["decode", "compile"]),
  reason: Schema.Literals([
    "DecodeFailed",
    "InvalidField",
    "ProfileReferenceNotFound",
    "UnknownConfiguredModel",
    "UnsupportedThinkingLevel",
    "ProfileHelpTooLarge",
    "ModelRuntimeInitializationFailed",
  ]),
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
    "NotAccepting",
    "AgentLimitExceeded",
    "UnknownProfile",
    "DuplicateInvocationId",
  ]),
  message: Schema.String,
}) {}

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
}) {}

export class RootStartError extends Schema.TaggedError<RootStartError>()("RootStartError", {
  message: Schema.String,
}) {}

export const PublicModelProfile = Schema.Struct({
  name: ProfileName,
  provider: Schema.String,
  model: Schema.String,
  thinkingLevel: ModelThinkingLevel,
});
export interface PublicModelProfile extends Schema.Schema.Type<typeof PublicModelProfile> {}

export interface ResolvedModelProfile {
  readonly public: PublicModelProfile;
  readonly description: string;
  readonly model: Model<Api>;
}

export interface ExactModelLookup {
  readonly getModel: (provider: string, model: string) => Model<Api> | undefined;
}

export interface ProfileCatalogue {
  readonly names: ReadonlyArray<ProfileName>;
  readonly profiles: HashMap.HashMap<ProfileName, ResolvedModelProfile>;
  readonly defaultProfile: ResolvedModelProfile;
  readonly rootProfile: ResolvedModelProfile;
  readonly helpText: string;
  readonly get: (name: ProfileName) => Option.Option<ResolvedModelProfile>;
}

const codePointLength = (value: string): number => Array.from(value).length;

const compileError = (
  reason: BroodConfigErrorReason,
  message: string,
  path?: string,
): BroodConfigError =>
  new BroodConfigError(
    path === undefined
      ? { stage: "compile", reason, message }
      : { stage: "compile", reason, message, path },
  );

export const compileProfileCatalogue = Effect.fn("Brood.compileProfileCatalogue")(function* (
  input: ProfilesConfigInput,
  models: ExactModelLookup,
  maxProfileHelpChars: number,
) {
  if (!Number.isSafeInteger(maxProfileHelpChars) || maxProfileHelpChars <= 0) {
    return yield* Effect.fail(
      compileError(
        "InvalidField",
        "maxProfileHelpChars must be a positive safe integer",
        "maxProfileHelpChars",
      ),
    );
  }

  const rawNames = Object.keys(input.profiles);
  if (rawNames.length === 0) {
    return yield* Effect.fail(
      compileError("InvalidField", "profiles must contain at least one entry", "profiles"),
    );
  }

  const validated: Array<{
    readonly name: ProfileName;
    readonly rawName: string;
    readonly profile: ModelProfile;
  }> = [];
  for (const rawName of rawNames.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const name = yield* decodeProfileName(rawName).pipe(
      Effect.mapError(() =>
        compileError("InvalidField", `Invalid profile name: ${rawName}`, `profiles.${rawName}`),
      ),
    );
    const profile = input.profiles[rawName];
    if (profile === undefined) {
      return yield* Effect.fail(
        compileError("InvalidField", `Missing profile value: ${rawName}`, `profiles.${rawName}`),
      );
    }
    if (codePointLength(profile.description) === 0 || codePointLength(profile.description) > 512) {
      return yield* Effect.fail(
        compileError(
          "InvalidField",
          `Profile ${rawName} description must contain 1 to 512 Unicode code points`,
          `profiles.${rawName}.description`,
        ),
      );
    }
    if (profile.provider.trim().length === 0 || profile.model.trim().length === 0) {
      return yield* Effect.fail(
        compileError(
          "InvalidField",
          `Profile ${rawName} provider and model must be non-empty`,
          `profiles.${rawName}`,
        ),
      );
    }
    validated.push({ name, rawName, profile: { ...profile } });
  }

  const defaultName = yield* decodeProfileName(input.defaultProfile).pipe(
    Effect.mapError(() =>
      compileError(
        "ProfileReferenceNotFound",
        `Invalid default profile: ${input.defaultProfile}`,
        "defaultProfile",
      ),
    ),
  );
  if (!validated.some(({ name }) => name === defaultName)) {
    return yield* Effect.fail(
      compileError(
        "ProfileReferenceNotFound",
        `Default profile does not exist: ${input.defaultProfile}`,
        "defaultProfile",
      ),
    );
  }

  const rootName =
    input.rootProfile === undefined
      ? defaultName
      : yield* decodeProfileName(input.rootProfile).pipe(
          Effect.mapError(() =>
            compileError(
              "ProfileReferenceNotFound",
              `Invalid root profile: ${input.rootProfile}`,
              "rootProfile",
            ),
          ),
        );
  if (!validated.some(({ name }) => name === rootName)) {
    return yield* Effect.fail(
      compileError(
        "ProfileReferenceNotFound",
        `Root profile does not exist: ${input.rootProfile}`,
        "rootProfile",
      ),
    );
  }

  const compiled = new Map<ProfileName, ResolvedModelProfile>();
  for (const { name, profile, rawName } of validated) {
    const model = models.getModel(profile.provider, profile.model);
    if (model === undefined) {
      return yield* Effect.fail(
        compileError(
          "UnknownConfiguredModel",
          `Unknown configured model ${profile.provider}/${profile.model} for profile ${rawName}`,
          `profiles.${rawName}`,
        ),
      );
    }
    const requestedThinking = profile.thinkingLevel ?? "medium";
    const effectiveThinking = clampThinkingLevel(model, requestedThinking);
    if (profile.thinkingLevel !== undefined && effectiveThinking !== profile.thinkingLevel) {
      return yield* Effect.fail(
        compileError(
          "UnsupportedThinkingLevel",
          `Model ${model.provider}/${model.id} clamps ${profile.thinkingLevel} to ${effectiveThinking}`,
          `profiles.${rawName}.thinkingLevel`,
        ),
      );
    }

    const publicProfile = Object.freeze({
      name,
      provider: model.provider,
      model: model.id,
      thinkingLevel: effectiveThinking,
    });
    compiled.set(
      name,
      Object.freeze({
        public: publicProfile,
        description: profile.description,
        model,
      }),
    );
  }

  const defaultProfile = compiled.get(defaultName);
  if (defaultProfile === undefined) {
    return yield* Effect.die(
      new Error(`Validated default profile ${defaultName} was not compiled`),
    );
  }
  const rootProfile = compiled.get(rootName);
  if (rootProfile === undefined) {
    return yield* Effect.die(new Error(`Validated root profile ${rootName} was not compiled`));
  }

  const names = Object.freeze(Array.from(compiled.keys()));
  const helpText = [
    `Default profile: ${defaultName}`,
    "Omitting a delegated task profile always uses the global default; profiles are not inherited.",
    "Available profiles:",
    ...names.map((name) => `- ${name}: ${compiled.get(name)?.description ?? ""}`),
  ].join("\n");
  if (codePointLength(helpText) > maxProfileHelpChars) {
    return yield* Effect.fail(
      compileError(
        "ProfileHelpTooLarge",
        `Rendered profile help contains ${codePointLength(helpText)} code points; maximum is ${maxProfileHelpChars}`,
        "profiles",
      ),
    );
  }

  const profiles = HashMap.fromIterable(compiled.entries());
  return Object.freeze({
    names,
    profiles,
    defaultProfile,
    rootProfile,
    helpText,
    get: (name: ProfileName) => HashMap.get(profiles, name),
  }) satisfies ProfileCatalogue;
});

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

export type AgentCommand =
  | { readonly _tag: "InitialGoal"; readonly goal: string }
  | {
      readonly _tag: "Resume";
      readonly waitId: WaitId;
      readonly outcomes: ReadonlyArray<DependencyOutcome>;
    };

export type PiRunOutcome =
  | { readonly _tag: "Completed"; readonly result: PiRunResult }
  | { readonly _tag: "Suspended" };

export interface PiRunResult {
  readonly finalText: string;
  readonly finalMessageId: string | undefined;
  readonly stopReason: "stop";
}

export type InterruptReason =
  | { readonly _tag: "OperatorRequested"; readonly source: "cli" | "api" }
  | { readonly _tag: "DrainTimeout"; readonly timeoutMillis: number }
  | { readonly _tag: "SupervisorShutdown" };

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

export class AgentFailed extends Data.TaggedError("AgentFailed")<{
  readonly failure: AgentFailure;
  readonly drain: DrainReport;
}> {}

export class RootInterrupted extends Data.TaggedError("RootInterrupted")<{
  readonly reason: InterruptReason;
  readonly drain: DrainReport;
}> {}

export const TRUNCATION_SENTINEL = "\n[truncated by Brood]";
export const MIN_BOUNDED_TEXT_CHARS = Array.from(TRUNCATION_SENTINEL).length;
export const minimumResumePromptChars = (maxAgents: number): number => 512 + maxAgents * 320;

export const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    /* oxlint-disable-next-line no-control-regex -- remove unsafe control text at a trust boundary. */
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

const truncateCodePoints = (
  value: string,
  maxCodePoints: number,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalCharacterCount: number;
} => {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) {
    return { text: value, truncated: false, originalCharacterCount: points.length };
  }
  const sentinel = Array.from(TRUNCATION_SENTINEL);
  const prefixLength = Math.max(0, maxCodePoints - sentinel.length);
  return {
    text: [...points.slice(0, prefixLength), ...sentinel.slice(0, maxCodePoints)]
      .slice(0, maxCodePoints)
      .join(""),
    truncated: true,
    originalCharacterCount: points.length,
  };
};

export const normalizeAgentResult = (
  agentId: AgentId,
  sessionId: string,
  finalText: string,
  maxAgentResultChars: number,
): AgentResult => {
  const normalized = normalizeText(finalText);
  const summary = truncateCodePoints(normalized, maxAgentResultChars);
  return {
    agentId,
    sessionId,
    summary: summary.text,
    truncated: summary.truncated,
    originalCharacterCount: summary.originalCharacterCount,
  };
};

const failureText = (failure: AgentFailure): string => {
  switch (failure._tag) {
    case "AgentStartFailed":
    case "AgentRunFailed":
    case "AgentProtocolFailed":
      return failure.error.message;
    case "AgentDefect":
      return "The agent controller failed unexpectedly. Inspect supervisor logs for the internal cause.";
  }
};

const interruptCode = (reason: InterruptReason): string => {
  switch (reason._tag) {
    case "OperatorRequested":
    case "DrainTimeout":
    case "SupervisorShutdown":
      return reason._tag;
  }
};

export const dependencyOutcomeFromAgent = (
  agentId: AgentId,
  name: AgentName,
  outcome: AgentOutcome,
  maxFailureMessageChars: number,
): DependencyOutcome => {
  switch (outcome._tag) {
    case "Completed":
      return { _tag: "Completed", agentId, name, result: outcome.result };
    case "Failed": {
      const message = truncateCodePoints(
        normalizeText(failureText(outcome.failure)),
        maxFailureMessageChars,
      ).text;
      return { _tag: "Failed", agentId, name, code: outcome.failure._tag, message };
    }
    case "Interrupted":
      return { _tag: "Interrupted", agentId, name, reason: interruptCode(outcome.reason) };
  }
};

const escapeXmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeXmlAttribute = (value: string): string =>
  escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const escapeXmlTextWithin = (value: string, maximum: number): string => {
  const escaped = escapeXmlText(value);
  if (codePointLength(escaped) <= maximum) return escaped;

  const sentinel = TRUNCATION_SENTINEL;
  const sentinelLength = codePointLength(sentinel);
  if (maximum < sentinelLength) {
    throw new RangeError("Resume body budget cannot fit the truncation sentinel");
  }
  const budget = maximum - sentinelLength;
  const parts: string[] = [];
  let used = 0;
  for (const point of Array.from(value)) {
    const encoded = escapeXmlText(point);
    const encodedLength = codePointLength(encoded);
    if (used + encodedLength > budget) break;
    parts.push(encoded);
    used += encodedLength;
  }
  return `${parts.join("")}${sentinel}`;
};

interface RenderedDependency {
  readonly header: string;
  readonly body: string;
  readonly footer: string;
}

const renderDependency = (outcome: DependencyOutcome): RenderedDependency => {
  switch (outcome._tag) {
    case "Completed":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="completed" truncated="${outcome.result.truncated}" original_characters="${outcome.result.originalCharacterCount}">`,
        body: outcome.result.summary,
        footer: "  </agent>",
      };
    case "Failed":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="failed" code="${escapeXmlAttribute(outcome.code)}">`,
        body: normalizeText(outcome.message),
        footer: "  </agent>",
      };
    case "Interrupted":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="interrupted" reason="${escapeXmlAttribute(outcome.reason)}">`,
        body: "The agent was interrupted before producing a result.",
        footer: "  </agent>",
      };
  }
};

export const renderAgentCommand = (command: AgentCommand, maxResumePromptChars: number): string => {
  if (command._tag === "InitialGoal") return normalizeText(command.goal);

  const opening = `<brood_dependency_outcomes version="1" wait_id="${escapeXmlAttribute(command.waitId)}">`;
  const closing = [
    "</brood_dependency_outcomes>",
    "",
    "Continue the original goal using these dependency outcomes. Detailed work may be available at the workspace paths named in the summaries.",
  ].join("\n");
  const dependencies = command.outcomes.map(renderDependency);
  const fixedLength = codePointLength(
    [opening, ...dependencies.flatMap(({ header, footer }) => [header, footer]), closing].join(
      "\n",
    ),
  );
  const bodySeparators = dependencies.length;
  if (fixedLength + bodySeparators > maxResumePromptChars) {
    throw new RangeError(
      `maxResumePromptChars=${maxResumePromptChars} cannot preserve every dependency header`,
    );
  }
  let remaining = maxResumePromptChars - fixedLength - bodySeparators;
  const rendered: string[] = [opening];
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency === undefined) continue;
    const entriesLeft = dependencies.length - index;
    const allowance = Math.floor(remaining / entriesLeft);
    const body = escapeXmlTextWithin(dependency.body, allowance);
    remaining -= codePointLength(body);
    rendered.push(dependency.header, body, dependency.footer);
  }
  rendered.push(closing);
  return rendered.join("\n");
};
