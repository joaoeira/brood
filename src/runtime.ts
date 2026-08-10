/**
 * Configuration and wiring: Schema decode of the raw config, cross-field
 * validation, directory preparation, one shared Pi ModelRuntime, and the
 * one-time profile-catalogue compilation. Every configuration failure is a
 * BroodConfigError; there is deliberately no second validation path.
 */
import { chmod, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Duration, Effect, Schema, SchemaIssue } from "effect";
import { BroodConfigError, PositiveInt } from "./agent.js";
import {
  ModelProfile,
  compileProfileCatalogue,
  type ProfileCatalogue,
  type ProfilesConfigInput,
} from "./profiles.js";
import {
  DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
  MIN_BOUNDED_TEXT_CHARS,
  minimumResumePromptChars,
} from "./render.js";

const BoundedTextChars = PositiveInt.check(Schema.isGreaterThanOrEqualTo(MIN_BOUNDED_TEXT_CHARS));
const PositiveFiniteDuration = Schema.DurationFromString.check(
  Schema.makeFilter((duration) => {
    const millis = Duration.toMillis(duration);
    return Number.isFinite(millis) && millis > 0 ? undefined : "must be finite and positive";
  }),
);

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const LEGACY_MAX_AGENTS = "`maxAgents` was renamed to `maxAgentAdmissions`; remove the old key";

const BroodConfigFields = Schema.Struct({
  workspacePath: Schema.Trim.check(Schema.isMinLength(1)),
  stateDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  maxConcurrency: PositiveInt,
  maxAgentAdmissions: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(128))),
  // Declared tombstone: the config cursor materializes only declared keys, so
  // this is the one mechanism that makes the legacy key a hard failure. A null
  // value is provider-erased before any schema sees it — a documented gap.
  maxAgents: Schema.optionalKey(Schema.Never.annotate({ message: LEGACY_MAX_AGENTS })),
  maxRunInstructionsChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4_000))),
  maxAgentResultChars: BoundedTextChars.pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000))),
  maxFailureMessageChars: BoundedTextChars.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_FAILURE_MESSAGE_CHARS)),
  ),
  maxResumePromptChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(48_000))),
  maxProfileHelpChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4_000))),
  drainTimeout: PositiveFiniteDuration.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("10 minutes")),
  ),
  sessionCleanupTimeout: PositiveFiniteDuration.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("30 seconds")),
  ),
  defaultProfile: Schema.String,
  rootProfile: Schema.optionalKey(Schema.String),
  profiles: Schema.Record(Schema.String, ModelProfile),
  piAgentDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  sessionDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  logLevel: Schema.optionalKey(Config.LogLevel),
});

export const BroodConfigInput = BroodConfigFields.check(
  Schema.makeFilter((config) => {
    const issues: Array<Schema.FilterIssue> = [];
    const workspacePath = resolve(config.workspacePath);
    const stateDirectory = resolve(config.stateDirectory);
    const piAgentDirectory = resolve(config.piAgentDirectory);
    const sessionDirectory = resolve(config.sessionDirectory);
    if (isWithin(workspacePath, stateDirectory) || isWithin(stateDirectory, workspacePath)) {
      issues.push({
        path: ["stateDirectory"],
        issue: "workspacePath and stateDirectory must be disjoint",
      });
    }
    if (!isWithin(stateDirectory, piAgentDirectory) || piAgentDirectory === stateDirectory) {
      issues.push({
        path: ["piAgentDirectory"],
        issue: "piAgentDirectory must be a child of stateDirectory",
      });
    }
    if (!isWithin(stateDirectory, sessionDirectory) || sessionDirectory === stateDirectory) {
      issues.push({
        path: ["sessionDirectory"],
        issue: "sessionDirectory must be a child of stateDirectory",
      });
    }
    if (config.maxConcurrency > config.maxAgentAdmissions) {
      issues.push({ path: ["maxConcurrency"], issue: "cannot exceed maxAgentAdmissions" });
    }
    const minimumResume = minimumResumePromptChars(config.maxAgentAdmissions);
    if (config.maxResumePromptChars < minimumResume) {
      issues.push({
        path: ["maxResumePromptChars"],
        issue: `must be at least ${minimumResume} for maxAgentAdmissions=${config.maxAgentAdmissions}`,
      });
    }
    return issues;
  }),
);

export type BroodConfigEncoded = typeof BroodConfigInput.Encoded;
type DecodedBroodConfig = typeof BroodConfigInput.Type;
export type BroodConfig = DecodedBroodConfig;

export interface BroodRuntime {
  readonly config: BroodConfig;
  readonly modelRuntime: ModelRuntime;
  readonly catalogue: ProfileCatalogue;
}

const ConfigRecipe = Config.schema(BroodConfigInput);

const configError = (message: string, path?: string): BroodConfigError =>
  new BroodConfigError(
    path === undefined
      ? { stage: "decode", reason: "InvalidField", message }
      : { stage: "decode", reason: "InvalidField", message, path },
  );

const resolveConfigPaths = (
  decoded: DecodedBroodConfig,
): Effect.Effect<BroodConfig, BroodConfigError> => {
  const workspacePath = resolve(decoded.workspacePath);
  const stateDirectory = resolve(decoded.stateDirectory);
  const piAgentDirectory = resolve(decoded.piAgentDirectory);
  const sessionDirectory = resolve(decoded.sessionDirectory);

  return Effect.succeed(
    Object.freeze({
      ...decoded,
      workspacePath,
      stateDirectory,
      piAgentDirectory,
      sessionDirectory,
      profiles: Object.freeze({ ...decoded.profiles }),
    }),
  );
};

const firstIssuePath = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> | undefined => {
  switch (issue._tag) {
    case "Pointer": {
      const nested = firstIssuePath(issue.issue);
      return nested === undefined ? issue.path : [...issue.path, ...nested];
    }
    case "Filter":
    case "Encoding":
      return firstIssuePath(issue.issue);
    case "Composite":
    case "AnyOf":
      for (const child of issue.issues) {
        const path = firstIssuePath(child);
        if (path !== undefined) return path;
      }
      return undefined;
    case "InvalidType":
    case "InvalidValue":
    case "MissingKey":
    case "UnexpectedKey":
    case "Forbidden":
    case "OneOf":
      return undefined;
  }
};

const configErrorPath = (error: Config.ConfigError): string | undefined => {
  if (!Schema.isSchemaError(error.cause)) return undefined;
  const path = firstIssuePath(error.cause.issue);
  return path?.map(String).join(".");
};

export const decodeBroodConfigUnknown = Effect.fn("Brood.decodeBroodConfigUnknown")(
  (raw: unknown) =>
    ConfigRecipe.parse(ConfigProvider.fromUnknown(raw, { preserveEmptyStrings: true })).pipe(
      Effect.mapError((error) => {
        const path = configErrorPath(error);
        return new BroodConfigError(
          path === undefined
            ? { stage: "decode", reason: "DecodeFailed", message: error.message }
            : { stage: "decode", reason: "DecodeFailed", message: error.message, path },
        );
      }),
      Effect.flatMap(resolveConfigPaths),
    ),
);

export const decodeBroodConfig = (raw: BroodConfigEncoded) => decodeBroodConfigUnknown(raw);

const prepareDirectories = Effect.fn("Brood.prepareDirectories")(function* (config: BroodConfig) {
  const configuredSharedDirectory = resolve(config.workspacePath, ".brood", "shared");
  const paths = [
    config.workspacePath,
    config.stateDirectory,
    config.piAgentDirectory,
    config.sessionDirectory,
  ] as const;
  yield* Effect.tryPromise({
    try: async () => {
      await Promise.all([
        mkdir(config.workspacePath, { recursive: true }),
        ...paths.slice(1).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
      ]);
      await mkdir(configuredSharedDirectory, { recursive: true });
    },
    catch: (cause) =>
      configError(
        `Unable to prepare Brood directories: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
  const [workspacePath, stateDirectory, piAgentDirectory, sessionDirectory, sharedDirectory] =
    yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          realpath(config.workspacePath),
          realpath(config.stateDirectory),
          realpath(config.piAgentDirectory),
          realpath(config.sessionDirectory),
          realpath(configuredSharedDirectory),
        ] as const),
      catch: (cause) =>
        configError(
          `Unable to resolve Brood directories: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
  if (
    isWithin(workspacePath, stateDirectory) ||
    isWithin(stateDirectory, workspacePath) ||
    !isWithin(stateDirectory, piAgentDirectory) ||
    !isWithin(stateDirectory, sessionDirectory) ||
    piAgentDirectory === sessionDirectory ||
    sharedDirectory === workspacePath ||
    !isWithin(workspacePath, sharedDirectory) ||
    isWithin(stateDirectory, sharedDirectory) ||
    isWithin(sharedDirectory, stateDirectory)
  ) {
    return yield* Effect.fail(
      configError(
        "Resolved workspace, shared, state, Pi-agent, and session directories violate separation rules",
        !isWithin(workspacePath, sharedDirectory) || sharedDirectory === workspacePath
          ? "workspacePath"
          : "stateDirectory",
      ),
    );
  }
  yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        [stateDirectory, piAgentDirectory, sessionDirectory].map((path) => chmod(path, 0o700)),
      ),
    catch: (cause) =>
      configError(
        `Unable to secure Brood state directories: ${cause instanceof Error ? cause.message : String(cause)}`,
        "stateDirectory",
      ),
  });
  return Object.freeze({
    ...config,
    workspacePath,
    stateDirectory,
    piAgentDirectory,
    sessionDirectory,
  }) satisfies BroodConfig;
});

const createModelRuntime = Effect.fn("Brood.createModelRuntime")((config: BroodConfig) =>
  Effect.tryPromise({
    try: (signal) =>
      ModelRuntime.create({
        authPath: resolve(config.piAgentDirectory, "auth.json"),
        modelsPath: resolve(config.piAgentDirectory, "models.json"),
        allowModelNetwork: false,
        signal,
      }),
    catch: (cause) =>
      new BroodConfigError({
        stage: "compile",
        reason: "ModelRuntimeInitializationFailed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }),
);

export const buildBroodRuntimeUnknown = Effect.fn("Brood.buildBroodRuntimeUnknown")(
  (raw: unknown) =>
    Effect.gen(function* () {
      const decoded = yield* decodeBroodConfigUnknown(raw);
      const config = yield* prepareDirectories(decoded);
      const modelRuntime = yield* createModelRuntime(config);
      const profileInput: ProfilesConfigInput = {
        defaultProfile: config.defaultProfile,
        profiles: config.profiles,
        ...(config.rootProfile === undefined ? {} : { rootProfile: config.rootProfile }),
      };
      const catalogue = yield* compileProfileCatalogue(
        profileInput,
        {
          getModel: (provider, model) => modelRuntime.getModel(provider, model),
        },
        config.maxProfileHelpChars,
      );
      return Object.freeze({ config, modelRuntime, catalogue }) satisfies BroodRuntime;
    }),
);

export const buildBroodRuntime = (raw: BroodConfigEncoded) => buildBroodRuntimeUnknown(raw);
