import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vitest";
import {
  AgentAdmissionCapacity,
  DelegateRejected,
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

it.effect("keeps overlong canonical paths in the typed delegation error contract", () =>
  Effect.gen(function* () {
    const error = yield* Schema.decodeUnknownEffect(DelegateRejected)({
      _tag: "DelegateRejected",
      reason: "PathTooLong",
      message: "The derived child path is too long; choose a shorter child name.",
    });

    expect(error.reason).toBe("PathTooLong");
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

it.effect("rejects inconsistent admission capacity at the schema boundary", () =>
  Effect.gen(function* () {
    const inconsistent = yield* Effect.exit(
      Schema.decodeUnknownEffect(AgentAdmissionCapacity)({ limit: 8, used: 3, remaining: 6 }),
    );
    const overUsed = yield* Effect.exit(
      Schema.decodeUnknownEffect(AgentAdmissionCapacity)({ limit: 3, used: 5, remaining: -2 }),
    );
    const consistent = yield* Schema.decodeUnknownEffect(AgentAdmissionCapacity)({
      limit: 8,
      used: 3,
      remaining: 5,
    });

    expect(Exit.isFailure(inconsistent)).toBe(true);
    expect(Exit.isFailure(overUsed)).toBe(true);
    expect(consistent).toEqual({ limit: 8, used: 3, remaining: 5 });
  }),
);
