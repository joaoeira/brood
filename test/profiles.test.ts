import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { compileProfileCatalogue } from "../src/profiles.js";
import { testModelLookup, testProfile, testProfilesConfig } from "./support/profiles.js";

it.effect("compiles an immutable, canonically ordered profile catalogue", () =>
  Effect.gen(function* () {
    const input = testProfilesConfig({
      rootProfile: "coordinator",
      profiles: {
        worker: testProfile(),
        coordinator: {
          description: "plans work",
          provider: "scripted",
          model: "scripted-small",
        },
      },
    });

    const catalogue = yield* compileProfileCatalogue(input, testModelLookup(), 4_000);

    expect(catalogue.names).toEqual(["coordinator", "worker"]);
    expect(catalogue.defaultProfile.public.name).toBe("worker");
    expect(catalogue.rootProfile.public.name).toBe("coordinator");
    expect(catalogue.rootProfile.public.thinkingLevel).toBe("off");
    expect(catalogue.helpText).toContain("Default profile: worker");
    expect(catalogue.helpText.indexOf("coordinator:")).toBeLessThan(
      catalogue.helpText.indexOf("worker:"),
    );
  }),
);

it.effect("rejects an unknown exact provider and model during catalogue compilation", () =>
  Effect.gen(function* () {
    const input = testProfilesConfig({
      profiles: {
        worker: testProfile({ provider: "Scripted", model: "SCRIPTED-SMALL" }),
      },
    });

    const error = yield* Effect.flip(compileProfileCatalogue(input, testModelLookup(), 4_000));

    expect(error._tag).toBe("BroodConfigError");
    expect(error.stage).toBe("compile");
    expect(error.reason).toBe("UnknownConfiguredModel");
  }),
);

it.effect("validates profile references before attempting model resolution", () =>
  Effect.gen(function* () {
    const input = testProfilesConfig({
      defaultProfile: "missing",
      profiles: {
        worker: testProfile({ provider: "unknown", model: "unknown" }),
      },
    });
    const error = yield* Effect.flip(compileProfileCatalogue(input, testModelLookup(), 4_000));
    expect(error.reason).toBe("ProfileReferenceNotFound");
    expect(error.path).toBe("defaultProfile");
  }),
);

it.effect("bounds profile descriptions by Unicode code point and rejects explicit clamps", () =>
  Effect.gen(function* () {
    const accepted = yield* compileProfileCatalogue(
      testProfilesConfig({
        profiles: { worker: testProfile({ description: "😀".repeat(512) }) },
      }),
      testModelLookup(),
      4_000,
    );
    expect(accepted.defaultProfile.description).toHaveLength(1_024);

    const tooLong = yield* Effect.flip(
      compileProfileCatalogue(
        testProfilesConfig({
          profiles: { worker: testProfile({ description: "😀".repeat(513) }) },
        }),
        testModelLookup(),
        4_000,
      ),
    );
    expect(tooLong.reason).toBe("InvalidField");

    const clamped = yield* Effect.flip(
      compileProfileCatalogue(
        testProfilesConfig({
          profiles: { worker: testProfile({ thinkingLevel: "high" }) },
        }),
        testModelLookup(),
        4_000,
      ),
    );
    expect(clamped.reason).toBe("UnsupportedThinkingLevel");
  }),
);

it.effect("copies configuration and exposes only the safe model projection", () =>
  Effect.gen(function* () {
    const worker = {
      description: "test worker",
      provider: "scripted",
      model: "scripted-small",
      thinkingLevel: "off" as const,
    };
    const input = testProfilesConfig({ profiles: { worker } });
    const catalogue = yield* compileProfileCatalogue(input, testModelLookup(), 4_000);
    worker.description = "mutated after compilation";
    worker.provider = "mutated";

    expect(catalogue.defaultProfile.description).toBe("test worker");
    const serialized = JSON.stringify(catalogue.defaultProfile.public);
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("description");
    expect(serialized).toContain('"name":"worker"');
  }),
);
