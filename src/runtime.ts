import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Duration, Effect, Schema } from "effect";
import {
  BroodConfigError,
  MIN_BOUNDED_TEXT_CHARS,
  ModelProfile,
  compileProfileCatalogue,
  minimumResumePromptChars,
  type ProfileCatalogue,
  type ProfilesConfigInput,
} from "./agent.js";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const BroodConfigInput = Schema.Struct({
  workspacePath: Schema.Trim.check(Schema.isMinLength(1)),
  stateDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  maxConcurrency: PositiveInt,
  maxAgents: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(128))),
  maxAgentResultChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000))),
  maxFailureMessageChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2_000))),
  maxResumePromptChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(48_000))),
  maxProfileHelpChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4_000))),
  drainTimeout: Schema.DurationFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("10 minutes")),
  ),
  sessionCleanupTimeout: Schema.DurationFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("30 seconds")),
  ),
  defaultProfile: Schema.String,
  rootProfile: Schema.optionalKey(Schema.String),
  profiles: Schema.Record(Schema.String, ModelProfile),
  piAgentDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  sessionDirectory: Schema.Trim.check(Schema.isMinLength(1)),
  logLevel: Schema.optionalKey(Config.LogLevel),
});

export type BroodConfigEncoded = typeof BroodConfigInput.Encoded;
type DecodedBroodConfig = typeof BroodConfigInput.Type;

export interface BroodConfig extends DecodedBroodConfig {
  readonly workspacePath: string;
  readonly stateDirectory: string;
  readonly piAgentDirectory: string;
  readonly sessionDirectory: string;
}

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

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const validateConfig = (
  decoded: DecodedBroodConfig,
): Effect.Effect<BroodConfig, BroodConfigError> => {
  const workspacePath = resolve(decoded.workspacePath);
  const stateDirectory = resolve(decoded.stateDirectory);
  const piAgentDirectory = resolve(decoded.piAgentDirectory);
  const sessionDirectory = resolve(decoded.sessionDirectory);

  if (isWithin(workspacePath, stateDirectory) || isWithin(stateDirectory, workspacePath)) {
    return Effect.fail(
      configError("workspacePath and stateDirectory must be disjoint", "stateDirectory"),
    );
  }
  if (!isWithin(stateDirectory, piAgentDirectory) || piAgentDirectory === stateDirectory) {
    return Effect.fail(
      configError("piAgentDirectory must be a child of stateDirectory", "piAgentDirectory"),
    );
  }
  if (!isWithin(stateDirectory, sessionDirectory) || sessionDirectory === stateDirectory) {
    return Effect.fail(
      configError("sessionDirectory must be a child of stateDirectory", "sessionDirectory"),
    );
  }
  if (decoded.maxConcurrency > decoded.maxAgents) {
    return Effect.fail(configError("maxConcurrency cannot exceed maxAgents", "maxConcurrency"));
  }
  if (decoded.maxAgentResultChars < MIN_BOUNDED_TEXT_CHARS) {
    return Effect.fail(
      configError(
        `maxAgentResultChars must be at least ${MIN_BOUNDED_TEXT_CHARS}`,
        "maxAgentResultChars",
      ),
    );
  }
  if (decoded.maxFailureMessageChars < MIN_BOUNDED_TEXT_CHARS) {
    return Effect.fail(
      configError(
        `maxFailureMessageChars must be at least ${MIN_BOUNDED_TEXT_CHARS}`,
        "maxFailureMessageChars",
      ),
    );
  }
  const minimumResume = minimumResumePromptChars(decoded.maxAgents);
  if (decoded.maxResumePromptChars < minimumResume) {
    return Effect.fail(
      configError(
        `maxResumePromptChars must be at least ${minimumResume} for maxAgents=${decoded.maxAgents}`,
        "maxResumePromptChars",
      ),
    );
  }
  if (
    !Number.isFinite(Duration.toMillis(decoded.drainTimeout)) ||
    Duration.toMillis(decoded.drainTimeout) <= 0
  ) {
    return Effect.fail(configError("drainTimeout must be finite and positive", "drainTimeout"));
  }
  if (
    !Number.isFinite(Duration.toMillis(decoded.sessionCleanupTimeout)) ||
    Duration.toMillis(decoded.sessionCleanupTimeout) <= 0
  ) {
    return Effect.fail(
      configError("sessionCleanupTimeout must be finite and positive", "sessionCleanupTimeout"),
    );
  }

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

export const decodeBroodConfig = Effect.fn("Brood.decodeBroodConfig")((raw: BroodConfigEncoded) =>
  ConfigRecipe.parse(ConfigProvider.fromUnknown(raw, { preserveEmptyStrings: true })).pipe(
    Effect.mapError(
      (error) =>
        new BroodConfigError({
          stage: "decode",
          reason: "DecodeFailed",
          message: String(error),
        }),
    ),
    Effect.flatMap(validateConfig),
  ),
);

const prepareDirectories = Effect.fn("Brood.prepareDirectories")(function* (config: BroodConfig) {
  const paths = [
    config.workspacePath,
    config.stateDirectory,
    config.piAgentDirectory,
    config.sessionDirectory,
  ] as const;
  yield* Effect.tryPromise({
    try: () => Promise.all(paths.map((path) => mkdir(path, { recursive: true }))),
    catch: (cause) =>
      configError(
        `Unable to prepare Brood directories: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
  const [workspacePath, stateDirectory, piAgentDirectory, sessionDirectory] =
    yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          realpath(config.workspacePath),
          realpath(config.stateDirectory),
          realpath(config.piAgentDirectory),
          realpath(config.sessionDirectory),
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
    piAgentDirectory === sessionDirectory
  ) {
    return yield* Effect.fail(
      configError(
        "Resolved workspace, state, Pi-agent, and session directories violate separation rules",
        "stateDirectory",
      ),
    );
  }
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

export const buildBroodRuntime = Effect.fn("Brood.buildBroodRuntime")((raw: BroodConfigEncoded) =>
  Effect.gen(function* () {
    const decoded = yield* decodeBroodConfig(raw);
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
