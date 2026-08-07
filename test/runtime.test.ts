// Plain Vitest is intentional: these tests exercise real filesystem and ModelRuntime boundaries.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { minimumResumePromptChars } from "../src/render.js";
import {
  buildBroodRuntime,
  decodeBroodConfig,
  decodeBroodConfigUnknown,
  type BroodConfigEncoded,
} from "../src/runtime.js";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "brood-runtime-test-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const validConfig = (): BroodConfigEncoded => ({
  workspacePath: join(base, "workspace"),
  stateDirectory: join(base, "state"),
  maxConcurrency: 2,
  defaultProfile: "worker",
  profiles: {
    worker: {
      description: "general work",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "low",
    },
  },
  piAgentDirectory: join(base, "state", "pi-agent"),
  sessionDirectory: join(base, "state", "sessions"),
});

describe("Brood runtime configuration", () => {
  it("decodes every programmatic input through defaults and durations", async () => {
    const config = await Effect.runPromise(decodeBroodConfig(validConfig()));
    expect(config.maxAgentAdmissions).toBe(128);
    expect(config.maxAgentResultChars).toBe(12_000);
    expect(config.maxProfileHelpChars).toBe(4_000);
    expect(Duration.toMillis(config.drainTimeout)).toBe(600_000);
    expect(Duration.toMillis(config.sessionCleanupTimeout)).toBe(30_000);
  });

  it("rejects overlapping workspace/state and invalid global bounds", async () => {
    await expect(
      Effect.runPromise(
        decodeBroodConfig({
          ...validConfig(),
          stateDirectory: join(base, "workspace", ".brood"),
          piAgentDirectory: join(base, "workspace", ".brood", "pi"),
          sessionDirectory: join(base, "workspace", ".brood", "sessions"),
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "BroodConfigError",
      reason: "DecodeFailed",
      path: "stateDirectory",
    });

    await expect(
      Effect.runPromise(
        decodeBroodConfig({ ...validConfig(), maxAgentAdmissions: 1, maxConcurrency: 2 }),
      ),
    ).rejects.toMatchObject({
      _tag: "BroodConfigError",
      reason: "DecodeFailed",
      path: "maxConcurrency",
      message: expect.stringContaining("maxAgentAdmissions"),
    });
  });

  it("derives the resume-prompt minimum from maxAgentAdmissions behaviorally", async () => {
    const budgetForOne = minimumResumePromptChars(1);
    const small = await Effect.runPromise(
      decodeBroodConfig({
        ...validConfig(),
        maxConcurrency: 1,
        maxAgentAdmissions: 1,
        maxResumePromptChars: budgetForOne,
      }),
    );
    expect(small.maxResumePromptChars).toBe(budgetForOne);

    await expect(
      Effect.runPromise(
        decodeBroodConfigUnknown({
          ...validConfig(),
          maxAgentAdmissions: 100,
          maxResumePromptChars: budgetForOne,
        }),
      ),
    ).rejects.toMatchObject({
      path: "maxResumePromptChars",
      message: expect.stringContaining("maxAgentAdmissions=100"),
    });
  });

  it("constructs one offline ModelRuntime and resolves the frozen catalogue", async () => {
    const runtime = await Effect.runPromise(buildBroodRuntime(validConfig()));
    expect(runtime.catalogue.defaultProfile.public).toMatchObject({
      name: "worker",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "low",
    });
    expect(runtime.config.workspacePath).toBe(await realpath(join(base, "workspace")));
    for (const path of [
      runtime.config.stateDirectory,
      runtime.config.piAgentDirectory,
      runtime.config.sessionDirectory,
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });

  it("reports exact-model failures through the single config error family", async () => {
    await expect(
      Effect.runPromise(
        buildBroodRuntime({
          ...validConfig(),
          profiles: {
            worker: {
              description: "general work",
              provider: "not-a-provider",
              model: "not-a-model",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "BroodConfigError",
      reason: "UnknownConfiguredModel",
    });
  });

  it("rejects bounds that cannot preserve truncation and resume envelopes", async () => {
    await expect(
      Effect.runPromise(decodeBroodConfig({ ...validConfig(), maxAgentResultChars: 4 })),
    ).rejects.toMatchObject({ _tag: "BroodConfigError", path: "maxAgentResultChars" });
    await expect(
      Effect.runPromise(decodeBroodConfig({ ...validConfig(), maxResumePromptChars: 1_000 })),
    ).rejects.toMatchObject({ _tag: "BroodConfigError", path: "maxResumePromptChars" });
  });

  it("rejects a symlink that aliases the state directory into the workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brood-config-symlink-"));
    try {
      const workspace = join(directory, "workspace");
      const stateAlias = join(directory, "state-link");
      await mkdir(workspace, { recursive: true });
      await symlink(workspace, stateAlias, "dir");
      const input: BroodConfigEncoded = {
        ...validConfig(),
        workspacePath: workspace,
        stateDirectory: stateAlias,
        piAgentDirectory: join(stateAlias, "pi"),
        sessionDirectory: join(stateAlias, "sessions"),
      };
      await expect(Effect.runPromise(buildBroodRuntime(input))).rejects.toMatchObject({
        _tag: "BroodConfigError",
        reason: "InvalidField",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("legacy maxAgents tombstone", () => {
  it("rejects the legacy key with the rename message at its path", async () => {
    const raw: unknown = { ...validConfig(), maxAgents: 50 };
    const error = await Effect.runPromise(Effect.flip(decodeBroodConfigUnknown(raw)));

    expect(error._tag).toBe("BroodConfigError");
    expect(error.reason).toBe("DecodeFailed");
    expect(error.path).toBe("maxAgents");
    expect(error.message).toContain("`maxAgents` was renamed to `maxAgentAdmissions`");
  });

  it("documents the provider-erasure gap: a null legacy value decodes as absent", async () => {
    const raw: unknown = { ...validConfig(), maxAgents: null };
    const config = await Effect.runPromise(decodeBroodConfigUnknown(raw));

    expect(config.maxAgentAdmissions).toBe(128);
  });

  it("rejects the legacy key at compile time for programmatic callers", () => {
    // @ts-expect-error the legacy maxAgents key is typed `never` in BroodConfigEncoded
    const rejected = { ...validConfig(), maxAgents: 50 } satisfies BroodConfigEncoded;
    void rejected;
    const accepted = validConfig() satisfies BroodConfigEncoded;
    expect(accepted.maxConcurrency).toBe(2);
  });

  it("defaults maxRunInstructionsChars to 4000 code points", async () => {
    const config = await Effect.runPromise(decodeBroodConfig(validConfig()));
    expect(config.maxRunInstructionsChars).toBe(4_000);
  });
});
