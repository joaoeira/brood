/**
 * Configuration and wiring: Schema decode of the raw config, cross-field
 * validation, directory preparation, one shared Pi ModelRuntime, and the
 * one-time profile-catalogue compilation. Every configuration failure is a
 * BroodConfigError; there is deliberately no second validation path.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Duration, Effect, Schema, SchemaIssue } from "effect";
import { BroodConfigError, PositiveInt } from "./agent.js";
import {
  ModelProfile,
  compileProfileCatalogue,
  type ProfileCatalogue,
  type ProfilesConfigInput,
} from "./profiles.js";
import {
  DEFAULT_MAX_RESUME_PROMPT_CHARS,
  DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
  MIN_BOUNDED_TEXT_CHARS,
  minimumResumePromptChars,
} from "./render.js";
import { assignOptional } from "./optional.js";

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

const OptionalPath = Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1)));

const BroodConfigFields = Schema.Struct({
  /** Defaults to the directory the config was loaded from. */
  workspacePath: OptionalPath,
  /** Defaults to ~/.brood, shared by every project. */
  stateDirectory: OptionalPath,
  maxConcurrency: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
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
  maxResumePromptChars: PositiveInt.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_RESUME_PROMPT_CHARS)),
  ),
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
  /** Set explicitly to give Brood its own Pi credentials; omitted, Brood uses
   * your existing `pi /login` (Pi's global agent directory) and keeps only
   * settings under the state directory. */
  piAgentDirectory: OptionalPath,
  /** Defaults to <stateDirectory>/sessions. */
  sessionDirectory: OptionalPath,
  logLevel: Schema.optionalKey(Config.LogLevel),
});

export const BroodConfigInput = BroodConfigFields.check(
  Schema.makeFilter((config) => {
    const issues: Array<Schema.FilterIssue> = [];
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

/** Shared default state root; one directory serves every project. */
export const defaultStateDirectory = (): string => join(homedir(), ".brood");

/** The decoded config with every path materialized and validated. */
export interface BroodConfig extends Omit<
  DecodedBroodConfig,
  "workspacePath" | "stateDirectory" | "piAgentDirectory" | "sessionDirectory"
> {
  readonly workspacePath: string;
  readonly stateDirectory: string;
  readonly piAgentDirectory: string;
  readonly sessionDirectory: string;
  /** "local" when piAgentDirectory was configured explicitly; otherwise Brood
   * borrows the credentials your `pi /login` maintains. */
  readonly piCredentials: "local" | "pi-global";
}

export interface PiAuthSource {
  readonly kind: "local" | "pi-global";
  readonly authPath: string;
}

export interface BroodRuntime {
  readonly config: BroodConfig;
  readonly modelRuntime: ModelRuntime;
  readonly catalogue: ProfileCatalogue;
  readonly authSource: PiAuthSource;
}

const ConfigRecipe = Config.schema(BroodConfigInput);

const configError = (message: string, path?: string): BroodConfigError =>
  new BroodConfigError(
    path === undefined
      ? { stage: "decode", reason: "InvalidField", message }
      : { stage: "decode", reason: "InvalidField", message, path },
  );

const pathError = (path: string, message: string): Effect.Effect<never, BroodConfigError> =>
  Effect.fail(new BroodConfigError({ stage: "decode", reason: "DecodeFailed", message, path }));

/** Materializes defaults against the config file's own directory and enforces
 * the one structural rule that matters: agents work in the workspace, so
 * nothing Brood stores may live inside it. */
const resolveConfigPaths = (
  decoded: DecodedBroodConfig,
  baseDir: string,
): Effect.Effect<BroodConfig, BroodConfigError> => {
  const workspacePath = resolve(baseDir, decoded.workspacePath ?? ".");
  const stateDirectory = resolve(baseDir, decoded.stateDirectory ?? defaultStateDirectory());
  const piCredentials = decoded.piAgentDirectory === undefined ? "pi-global" : "local";
  const piAgentDirectory =
    decoded.piAgentDirectory === undefined
      ? join(stateDirectory, "pi-agent")
      : resolve(baseDir, decoded.piAgentDirectory);
  const sessionDirectory =
    decoded.sessionDirectory === undefined
      ? join(stateDirectory, "sessions")
      : resolve(baseDir, decoded.sessionDirectory);

  if (isWithin(workspacePath, stateDirectory) || isWithin(stateDirectory, workspacePath)) {
    return pathError("stateDirectory", "workspacePath and stateDirectory must be disjoint");
  }
  if (isWithin(workspacePath, piAgentDirectory) || isWithin(piAgentDirectory, workspacePath)) {
    return pathError("piAgentDirectory", "piAgentDirectory must be disjoint from workspacePath");
  }
  if (isWithin(workspacePath, sessionDirectory) || isWithin(sessionDirectory, workspacePath)) {
    return pathError("sessionDirectory", "sessionDirectory must be disjoint from workspacePath");
  }
  if (piAgentDirectory === sessionDirectory) {
    return pathError("sessionDirectory", "piAgentDirectory and sessionDirectory must differ");
  }

  return Effect.succeed(
    Object.freeze({
      ...decoded,
      workspacePath,
      stateDirectory,
      piAgentDirectory,
      sessionDirectory,
      piCredentials,
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
  (raw: Parameters<typeof ConfigProvider.fromUnknown>[0], baseDir: string = process.cwd()) =>
    ConfigRecipe.parse(ConfigProvider.fromUnknown(raw, { preserveEmptyStrings: true })).pipe(
      Effect.mapError((error) => {
        const path = configErrorPath(error);
        return new BroodConfigError(
          path === undefined
            ? { stage: "decode", reason: "DecodeFailed", message: error.message }
            : { stage: "decode", reason: "DecodeFailed", message: error.message, path },
        );
      }),
      Effect.flatMap((decoded) => resolveConfigPaths(decoded, baseDir)),
    ),
);

export const decodeBroodConfig = (raw: BroodConfigEncoded, baseDir?: string) =>
  decodeBroodConfigUnknown(raw, baseDir);

const prepareDirectories = Effect.fn("Brood.prepareDirectories")(function* (config: BroodConfig) {
  const configuredBroodDirectory = resolve(config.workspacePath, ".brood");
  const configuredSharedDirectory = resolve(config.workspacePath, ".brood", "shared");
  const paths = [
    config.workspacePath,
    config.stateDirectory,
    config.piAgentDirectory,
    config.sessionDirectory,
  ] as const;
  yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        mkdir(config.workspacePath, { recursive: true }),
        ...paths.slice(1).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
      ]),
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
    isWithin(workspacePath, piAgentDirectory) ||
    isWithin(workspacePath, sessionDirectory) ||
    piAgentDirectory === sessionDirectory
  ) {
    return yield* Effect.fail(
      configError(
        "Resolved workspace, state, Pi-agent, and session directories violate separation rules",
        "stateDirectory",
      ),
    );
  }
  const broodDirectory = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(configuredBroodDirectory, { recursive: true });
      return realpath(configuredBroodDirectory);
    },
    catch: (cause) =>
      configError(
        `Unable to prepare the shared Brood directory: ${cause instanceof Error ? cause.message : String(cause)}`,
        "workspacePath",
      ),
  });
  if (broodDirectory === workspacePath || !isWithin(workspacePath, broodDirectory)) {
    return yield* Effect.fail(
      configError("Resolved .brood directory escapes the workspace", "workspacePath"),
    );
  }
  const sharedDirectory = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(configuredSharedDirectory, { recursive: true });
      return realpath(configuredSharedDirectory);
    },
    catch: (cause) =>
      configError(
        `Unable to prepare the shared Brood directory: ${cause instanceof Error ? cause.message : String(cause)}`,
        "workspacePath",
      ),
  });
  if (
    sharedDirectory === workspacePath ||
    !isWithin(workspacePath, sharedDirectory) ||
    isWithin(stateDirectory, sharedDirectory) ||
    isWithin(sharedDirectory, stateDirectory)
  ) {
    return yield* Effect.fail(
      configError("Resolved shared directory violates workspace separation rules", "workspacePath"),
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

interface CreatedModelRuntime {
  readonly modelRuntime: ModelRuntime;
  readonly authSource: PiAuthSource;
}

/**
 * With an explicitly configured piAgentDirectory, Brood keeps project-local
 * credentials there, exactly as before. Otherwise it omits the paths so Pi
 * resolves its own global agent directory — the same auth.json that
 * `pi /login` maintains and that Pi serializes across processes with a file
 * lock — and one login covers every Brood project.
 */
const createModelRuntime = Effect.fn("Brood.createModelRuntime")(function* (config: BroodConfig) {
  const runtimeError = (cause: unknown): BroodConfigError =>
    new BroodConfigError({
      stage: "compile",
      reason: "ModelRuntimeInitializationFailed",
      message: cause instanceof Error ? cause.message : String(cause),
    });

  if (config.piCredentials === "local") {
    const authPath = resolve(config.piAgentDirectory, "auth.json");
    const modelRuntime = yield* Effect.tryPromise({
      try: (signal) =>
        ModelRuntime.create({
          authPath,
          modelsPath: resolve(config.piAgentDirectory, "models.json"),
          allowModelNetwork: false,
          signal,
        }),
      catch: runtimeError,
    });
    return { modelRuntime, authSource: { kind: "local", authPath } } satisfies CreatedModelRuntime;
  }

  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) {
    return yield* Effect.fail(
      new BroodConfigError({
        stage: "compile",
        reason: "ModelRuntimeInitializationFailed",
        message: `No Pi credentials found at ${authPath}. Run \`pi /login\` once to share your Pi login with every Brood project, or set piAgentDirectory to a directory containing auth.json.`,
      }),
    );
  }
  const modelRuntime = yield* Effect.tryPromise({
    try: (signal) => ModelRuntime.create({ allowModelNetwork: false, signal }),
    catch: runtimeError,
  });
  return {
    modelRuntime,
    authSource: { kind: "pi-global", authPath },
  } satisfies CreatedModelRuntime;
});

export const buildBroodRuntimeUnknown = Effect.fn("Brood.buildBroodRuntimeUnknown")(
  (raw: Parameters<typeof decodeBroodConfigUnknown>[0], baseDir?: string) =>
    Effect.gen(function* () {
      const decoded = yield* decodeBroodConfigUnknown(raw, baseDir);
      const config = yield* prepareDirectories(decoded);
      const { modelRuntime, authSource } = yield* createModelRuntime(config);
      const profileInput: ProfilesConfigInput = {
        defaultProfile: config.defaultProfile,
        profiles: config.profiles,
      };
      assignOptional(profileInput, "rootProfile", config.rootProfile);
      const catalogue = yield* compileProfileCatalogue(
        profileInput,
        {
          getModel: (provider, model) => modelRuntime.getModel(provider, model),
        },
        config.maxProfileHelpChars,
      );
      return Object.freeze({ config, modelRuntime, catalogue, authSource }) satisfies BroodRuntime;
    }),
);

export const buildBroodRuntime = (raw: BroodConfigEncoded, baseDir?: string) =>
  buildBroodRuntimeUnknown(raw, baseDir);
