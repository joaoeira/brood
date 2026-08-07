import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
  decodeBroodControl,
  decodeAgentName,
  decodeProfileName,
  makeToolInvocationId,
} from "../src/agent.js";

it.effect("normalizes agent names while keeping profile names exact", () =>
  Effect.gen(function* () {
    const agentName = yield* decodeAgentName("  api_worker-1  ");
    const paddedProfile = yield* Effect.exit(decodeProfileName(" worker "));

    expect(agentName).toBe("api_worker-1");
    expect(Exit.isFailure(paddedProfile)).toBe(true);
  }),
);

it.effect("decodes only the versioned Brood control protocol", () =>
  Effect.gen(function* () {
    const invocationId = makeToolInvocationId("tool-call-1");
    const control = yield* decodeBroodControl({
      version: 1,
      kind: "suspend",
      invocationId,
    });
    const futureVersion = yield* Effect.exit(
      decodeBroodControl({ version: 2, kind: "suspend", invocationId }),
    );

    expect(control).toEqual({ version: 1, kind: "suspend", invocationId });
    expect(Exit.isFailure(futureVersion)).toBe(true);
  }),
);
