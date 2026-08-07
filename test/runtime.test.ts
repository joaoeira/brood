import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { buildBroodRuntime, decodeBroodConfig, type BroodConfigEncoded } from "../src/runtime.js";

const base = "/tmp/brood-runtime-test";

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
    expect(config.maxAgents).toBe(128);
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
    ).rejects.toMatchObject({ _tag: "BroodConfigError", reason: "InvalidField" });

    await expect(
      Effect.runPromise(decodeBroodConfig({ ...validConfig(), maxAgents: 1, maxConcurrency: 2 })),
    ).rejects.toMatchObject({ _tag: "BroodConfigError", reason: "InvalidField" });
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
});
