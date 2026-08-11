/**
 * Entry point: read argv and the config file, pick a bridge, hand the terminal
 * to OpenTUI.
 *
 * Everything that can fail with a message the operator needs to read — a
 * missing config, bad JSON, a config Brood rejects — is resolved here, before
 * the renderer takes over the screen. Once the alternate screen is up, a thrown
 * error is a much worse experience than a line on stderr.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createDemoBridge } from "./bridge/demo";
import { createLiveBridge } from "./bridge/live";
import type { BridgeHandle, ConfigSummary } from "./bridge/types";
import { App } from "./components/App";
import { store } from "./store";

const DEMO_GOAL = "Ship the public read API for the changelog service";

interface Arguments {
  readonly configPath: string;
  readonly demo: boolean;
}

const usage =
  "Usage: brood-tui [--config <brood.json>] [--demo]\n" +
  "       BROOD_TUI_DEMO=1 runs the scripted demo swarm with no config or credentials.";

const parseArguments = (argv: ReadonlyArray<string>): Arguments => {
  let configPath = "brood.json";
  let demo = process.env["BROOD_TUI_DEMO"] === "1";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" || argument === "-c") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Missing value for ${argument}.\n${usage}`);
      }
      configPath = value;
      index += 1;
    } else if (argument === "--demo") {
      demo = true;
    } else if (argument === "--help" || argument === "-h") {
      throw new Error(usage);
    } else if (argument !== undefined) {
      throw new Error(`Unknown option: ${argument}\n${usage}`);
    }
  }
  return { configPath: resolve(configPath), demo };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asText = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const asCount = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * A best-effort read of the raw config for display. Brood's own decoder is the
 * authority and runs a moment later inside the bridge; this only needs to be
 * good enough to fill a header, and must not reject a config Brood would accept.
 */
const summarize = (configPath: string, raw: unknown): ConfigSummary => {
  const config = asRecord(raw);
  const profiles = asRecord(config["profiles"]);
  return {
    configPath,
    workspacePath: asText(config["workspacePath"], dirname(configPath)),
    sessionDirectory: asText(config["sessionDirectory"], ""),
    maxConcurrency: asCount(config["maxConcurrency"], 4),
    maxAgentAdmissions: asCount(config["maxAgentAdmissions"], 128),
    defaultProfile: asText(config["defaultProfile"], "(none)"),
    profileNames: Object.keys(profiles),
    authLabel: "resolving…",
  };
};

const buildBridge = async (parsed: Arguments): Promise<BridgeHandle> => {
  if (parsed.demo) {
    store.setGoalDraft(DEMO_GOAL);
    return createDemoBridge();
  }
  let text: string;
  try {
    text = await readFile(parsed.configPath, "utf8");
  } catch (cause: unknown) {
    throw new Error(
      `Unable to read config ${parsed.configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(text);
  } catch (cause: unknown) {
    throw new Error(
      `Invalid JSON in ${parsed.configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return createLiveBridge({
    rawConfig,
    baseDir: dirname(parsed.configPath),
    configSummary: summarize(parsed.configPath, rawConfig),
  });
};

const main = async (): Promise<void> => {
  const parsed = parseArguments(process.argv.slice(2));
  const bridge = await buildBridge(parsed);
  // Ctrl+C is routed through the app's confirm-quit dialog so a live swarm is
  // interrupted and drained instead of dying with the process.
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App bridge={bridge} />);
};

try {
  await main();
} catch (cause: unknown) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
