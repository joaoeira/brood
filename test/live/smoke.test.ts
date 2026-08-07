import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBroodApplicationFromUnknown } from "../../src/main.js";

const configPath = process.env.BROOD_LIVE_CONFIG;

describe.skipIf(configPath === undefined)("live provider smoke", () => {
  it(
    "runs a real root session and closes the scoped swarm",
    async () => {
      if (configPath === undefined) throw new Error("BROOD_LIVE_CONFIG disappeared");
      const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
      const result = await Effect.runPromise(
        Effect.scoped(
          makeBroodApplicationFromUnknown(raw).pipe(
            Effect.flatMap((application) =>
              application.run(
                "Complete a tiny task. Delegate one child, wait for it, and summarize the result.",
              ),
            ),
          ),
        ),
      );

      expect(result.root.summary.length).toBeGreaterThan(0);
      expect(result.drain.terminalAgentCount).toBeGreaterThanOrEqual(2);
    },
    10 * 60 * 1_000,
  );
});
