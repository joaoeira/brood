/**
 * Model-profile catalogue: operator configuration schemas and the one-time
 * compilation of exact `(provider, model)` pairs into resolved Pi models.
 *
 * A catalogue is compiled once per run and frozen. Only `PublicModelProfile`
 * may cross a serialization or monitoring boundary; the private resolved
 * `Model` can carry endpoints, headers, and credentials.
 */
import type { Api, Model, ModelThinkingLevel as PiModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Effect, HashMap, Option, Schema } from "effect";
import {
  BroodConfigError,
  ProfileName,
  decodeProfileName,
  type BroodConfigErrorReason,
} from "./agent.js";

export type ModelThinkingLevel = PiModelThinkingLevel;

// Two-direction drift guard against the pinned pi-ai union: `satisfies` fails
// compilation when a listed level disappears upstream, and the exhaustive
// record fails compilation when upstream adds a level this list is missing.
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ModelThinkingLevel>;

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

interface ValidatedProfile {
  readonly name: ProfileName;
  readonly rawName: string;
  readonly profile: ModelProfile;
}

const validateProfileHelpBudget = (maximum: number): Effect.Effect<void, BroodConfigError> =>
  Number.isSafeInteger(maximum) && maximum > 0
    ? Effect.void
    : Effect.fail(
        compileError(
          "InvalidField",
          "maxProfileHelpChars must be a positive safe integer",
          "maxProfileHelpChars",
        ),
      );

const validateProfileDefinitions = Effect.fn("Brood.validateProfileDefinitions")(function* (
  profiles: Readonly<Record<string, ModelProfile>>,
) {
  const rawNames = Object.keys(profiles).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (rawNames.length === 0) {
    return yield* Effect.fail(
      compileError("InvalidField", "profiles must contain at least one entry", "profiles"),
    );
  }
  return yield* Effect.forEach(rawNames, (rawName) =>
    Effect.gen(function* () {
      const name = yield* decodeProfileName(rawName).pipe(
        Effect.mapError(() =>
          compileError("InvalidField", `Invalid profile name: ${rawName}`, `profiles.${rawName}`),
        ),
      );
      const profile = profiles[rawName];
      if (profile === undefined) {
        return yield* Effect.fail(
          compileError("InvalidField", `Missing profile value: ${rawName}`, `profiles.${rawName}`),
        );
      }
      const descriptionLength = codePointLength(profile.description);
      if (descriptionLength === 0 || descriptionLength > 512) {
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
      return { name, rawName, profile } satisfies ValidatedProfile;
    }),
  );
});

const resolveProfileReference = Effect.fn("Brood.resolveProfileReference")(function* (
  rawName: string,
  path: "defaultProfile" | "rootProfile",
  validated: ReadonlyArray<ValidatedProfile>,
) {
  const label = path === "defaultProfile" ? "Default" : "Root";
  const name = yield* decodeProfileName(rawName).pipe(
    Effect.mapError(() =>
      compileError(
        "ProfileReferenceNotFound",
        `Invalid ${label.toLowerCase()} profile: ${rawName}`,
        path,
      ),
    ),
  );
  if (!validated.some((profile) => profile.name === name)) {
    return yield* Effect.fail(
      compileError("ProfileReferenceNotFound", `${label} profile does not exist: ${rawName}`, path),
    );
  }
  return name;
});

const compileResolvedProfiles = Effect.fn("Brood.compileResolvedProfiles")(function* (
  validated: ReadonlyArray<ValidatedProfile>,
  models: ExactModelLookup,
) {
  const entries = yield* Effect.forEach(validated, ({ name, profile, rawName }) =>
    Effect.gen(function* () {
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
      const resolved = Object.freeze({
        public: Object.freeze({
          name,
          provider: model.provider,
          model: model.id,
          thinkingLevel: effectiveThinking,
        }),
        description: profile.description,
        model,
      }) satisfies ResolvedModelProfile;
      return [name, resolved] as const;
    }),
  );
  return new Map(entries);
});

const requireCompiledProfile = (
  profiles: ReadonlyMap<ProfileName, ResolvedModelProfile>,
  name: ProfileName,
  role: "default" | "root",
): Effect.Effect<ResolvedModelProfile> => {
  const profile = profiles.get(name);
  return profile === undefined
    ? Effect.die(new Error(`Validated ${role} profile ${name} was not compiled`))
    : Effect.succeed(profile);
};

const renderProfileHelp = (
  names: ReadonlyArray<ProfileName>,
  profiles: ReadonlyMap<ProfileName, ResolvedModelProfile>,
  defaultName: ProfileName,
  maximum: number,
): Effect.Effect<string, BroodConfigError> => {
  const helpText = [
    `Default profile: ${defaultName}`,
    "Omitting a delegated task profile always uses the global default; profiles are not inherited.",
    "Available profiles:",
    ...names.map((name) => `- ${name}: ${profiles.get(name)?.description ?? ""}`),
  ].join("\n");
  const length = codePointLength(helpText);
  return length <= maximum
    ? Effect.succeed(helpText)
    : Effect.fail(
        compileError(
          "ProfileHelpTooLarge",
          `Rendered profile help contains ${length} code points; maximum is ${maximum}`,
          "profiles",
        ),
      );
};

export const compileProfileCatalogue = Effect.fn("Brood.compileProfileCatalogue")(function* (
  input: ProfilesConfigInput,
  models: ExactModelLookup,
  maxProfileHelpChars: number,
) {
  yield* validateProfileHelpBudget(maxProfileHelpChars);
  const validated = yield* validateProfileDefinitions(input.profiles);
  const defaultName = yield* resolveProfileReference(
    input.defaultProfile,
    "defaultProfile",
    validated,
  );
  const rootName =
    input.rootProfile === undefined
      ? defaultName
      : yield* resolveProfileReference(input.rootProfile, "rootProfile", validated);
  const compiled = yield* compileResolvedProfiles(validated, models);
  const defaultProfile = yield* requireCompiledProfile(compiled, defaultName, "default");
  const rootProfile = yield* requireCompiledProfile(compiled, rootName, "root");
  const names = Object.freeze(Array.from(compiled.keys()));
  const helpText = yield* renderProfileHelp(names, compiled, defaultName, maxProfileHelpChars);
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
