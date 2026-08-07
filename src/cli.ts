#!/usr/bin/env node
/**
 * Thin operator shell over main.ts: argument parsing, the interactive
 * status / show / interrupt / events commands, and newline-delimited JSON output for
 * non-interactive callers. No supervisor internals are reachable from here.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Cause, Data, Effect, Exit, Match, Option, Queue, Ref, Stream } from "effect";
import {
  AgentFailed,
  BroodConfigError,
  RootInterrupted,
  RootStartError,
  type BroodRunRequestEncoded,
} from "./agent.js";
import { makeBroodApplicationFromUnknown, type BroodApplication } from "./main.js";
import { formatAgentDetail, formatSwarmStatus } from "./status.js";

export interface CliArguments {
  readonly configPath: string;
  readonly goal: string;
  readonly showEvents: boolean;
  readonly instructionsFile: string | undefined;
}

type ParsedOperatorCommand =
  | { readonly _tag: "Status"; readonly format: "human" | "json" }
  | { readonly _tag: "Show"; readonly reference: string; readonly format: "human" | "json" }
  | { readonly _tag: "Interrupt"; readonly reference: string }
  | { readonly _tag: "Events"; readonly enabled: boolean }
  | { readonly _tag: "Help" };

class CliInputError extends Data.TaggedError("CliInputError")<{
  readonly message: string;
}> {}

const usage =
  'Usage: brood --config <brood.json> [--events] [--instructions-file <charter.md>] --goal "<goal>"\n' +
  "       brood --config <brood.json> [--events] [--instructions-file <charter.md>] <goal...>";

export const parseCliArguments = (arguments_: ReadonlyArray<string>): CliArguments => {
  let configPath: string | undefined;
  let explicitGoal: string | undefined;
  let instructionsFile: string | undefined;
  let showEvents = false;
  const positional: Array<string> = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--config" || argument === "-c") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliInputError({ message: `Missing value for ${argument}.\n${usage}` });
      }
      configPath = value;
      index += 1;
    } else if (argument === "--instructions-file") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliInputError({ message: `Missing value for ${argument}.\n${usage}` });
      }
      instructionsFile = value;
      index += 1;
    } else if (argument === "--goal" || argument === "-g") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliInputError({ message: `Missing value for ${argument}.\n${usage}` });
      }
      explicitGoal = value;
      index += 1;
    } else if (argument === "--events") {
      showEvents = true;
    } else if (argument === "--help" || argument === "-h") {
      throw new CliInputError({ message: usage });
    } else if (argument?.startsWith("-")) {
      throw new CliInputError({ message: `Unknown option: ${argument}\n${usage}` });
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }

  if (configPath === undefined || configPath.trim() === "") {
    throw new CliInputError({ message: `Missing --config.\n${usage}` });
  }
  // Presence only: goal *content* (emptiness, whitespace, control characters)
  // is judged by normalizeRunRequest, the single semantic gate.
  if (explicitGoal === undefined && positional.length === 0) {
    throw new CliInputError({ message: `Missing goal.\n${usage}` });
  }
  const goal = explicitGoal ?? positional.join(" ");
  return {
    configPath: resolve(configPath),
    goal,
    showEvents,
    instructionsFile: instructionsFile === undefined ? undefined : resolve(instructionsFile),
  };
};

export const parseOperatorCommand = (line: string): ParsedOperatorCommand => {
  const [command, ...rest] = line.trim().split(/\s+/);
  switch (command) {
    case "status": {
      if (rest.length === 0) return { _tag: "Status", format: "human" };
      if (rest.length === 1 && rest[0] === "--json") {
        return { _tag: "Status", format: "json" };
      }
      throw new CliInputError({ message: "Usage: status [--json]" });
    }
    case "show": {
      const [reference, option] = rest;
      if (
        reference === undefined ||
        reference.startsWith("-") ||
        rest.length > 2 ||
        (option !== undefined && option !== "--json")
      ) {
        throw new CliInputError({ message: "Usage: show <agent-path-or-id> [--json]" });
      }
      return { _tag: "Show", reference, format: option === "--json" ? "json" : "human" };
    }
    case "interrupt": {
      const raw = rest[0];
      if (raw === undefined || raw.startsWith("-") || rest.length !== 1) {
        throw new CliInputError({ message: "Usage: interrupt <agent-path-or-id>" });
      }
      return { _tag: "Interrupt", reference: raw };
    }
    case "events":
      if (rest.length === 1 && (rest[0] === "on" || rest[0] === "off")) {
        return { _tag: "Events", enabled: rest[0] === "on" };
      }
      throw new CliInputError({ message: "Usage: events on|off" });
    case "help":
    case "":
      return { _tag: "Help" };
    default:
      throw new CliInputError({ message: `Unknown command: ${command}` });
  }
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const decodeOperatorCommand = Effect.fn("Brood.Cli.decodeOperatorCommand")(
  (line: string): Effect.Effect<ParsedOperatorCommand, CliInputError> =>
    Effect.try({
      try: () => parseOperatorCommand(line),
      catch: (cause) =>
        cause instanceof CliInputError
          ? cause
          : new CliInputError({ message: causeMessage(cause) }),
    }),
);

const writeJson = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });

const writeMessage = (message: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

const loadConfig = (path: string): Effect.Effect<unknown, CliInputError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new CliInputError({
        message: `Unable to read config ${path}: ${causeMessage(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) =>
          new CliInputError({
            message: `Invalid JSON in ${path}: ${causeMessage(cause)}`,
          }),
      }),
    ),
  );

const commandLines = (): Stream.Stream<string> =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const readline = createInterface({
          input: process.stdin,
          output: process.stderr,
          terminal: true,
        });
        const onLine = (line: string): void => {
          Queue.offerUnsafe(queue, line);
        };
        const onClose = (): void => {
          Queue.endUnsafe(queue);
        };
        readline.on("line", onLine);
        readline.on("close", onClose);
        return { readline, onLine, onClose };
      }),
      ({ readline, onLine, onClose }) =>
        Effect.sync(() => {
          readline.off("line", onLine);
          readline.off("close", onClose);
          readline.close();
        }),
    ),
  );

const executeCommand = (
  application: BroodApplication,
  eventDisplay: Ref.Ref<boolean>,
  line: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const command = yield* decodeOperatorCommand(line);
    switch (command._tag) {
      case "Status": {
        const status = yield* application.controller.status;
        yield* command.format === "json"
          ? writeJson(status)
          : writeMessage(formatSwarmStatus(status));
        break;
      }
      case "Show": {
        const detail = yield* application.controller.show(command.reference);
        yield* command.format === "json"
          ? writeJson(detail)
          : writeMessage(formatAgentDetail(detail));
        break;
      }
      case "Interrupt": {
        const agentId = yield* application.controller.interrupt(command.reference, "cli");
        yield* writeJson({ type: "interrupt-requested", reference: command.reference, agentId });
        break;
      }
      case "Events":
        yield* Ref.set(eventDisplay, command.enabled);
        yield* writeMessage(`Event display ${command.enabled ? "enabled" : "disabled"}.`);
        break;
      case "Help":
        yield* writeMessage(
          "Commands: status [--json] | show <agent-path-or-id> [--json] | interrupt <agent-path-or-id> | events on|off | help",
        );
        break;
    }
  }).pipe(Effect.catch((cause) => writeMessage(causeMessage(cause))));

/** Reads the operator charter once before the run starts. File-read failures
 * are CLI input errors; the contents pass through exactly the same request
 * normalization as the programmatic API — no second decoder. */
export const loadInstructions = (
  path: string | undefined,
): Effect.Effect<string | undefined, CliInputError> =>
  path === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) =>
          new CliInputError({
            message: `Unable to read instructions file ${path}: ${causeMessage(cause)}`,
          }),
      });

const runApplication = (
  application: BroodApplication,
  arguments_: CliArguments,
  request: BroodRunRequestEncoded,
) =>
  Effect.gen(function* () {
    const interactive = process.stdin.isTTY === true;
    const eventDisplay = yield* Ref.make(!interactive || arguments_.showEvents);

    const eventSubscription = yield* application.controller.events;
    yield* Stream.fromSubscription(eventSubscription).pipe(
      Stream.runForEach((event) =>
        Ref.get(eventDisplay).pipe(
          Effect.flatMap((enabled) =>
            enabled ? writeJson({ type: "event", event }) : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    if (interactive) {
      yield* writeMessage(
        "Brood is running. Commands: status | show <agent-path-or-id> | interrupt <agent-path-or-id> | events on|off",
      );
      yield* commandLines().pipe(
        Stream.runForEach((line) => executeCommand(application, eventDisplay, line)),
        Effect.forkScoped,
      );
    }
    const result = yield* application.run(request);
    yield* writeJson({ type: "completed", result });
    return result;
  });

type CliFailure = CliInputError | BroodConfigError | AgentFailed | RootInterrupted | RootStartError;

export const runCli = (arguments_: ReadonlyArray<string>): Effect.Effect<unknown, CliFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => parseCliArguments(arguments_),
        catch: (cause) =>
          cause instanceof CliInputError
            ? cause
            : new CliInputError({ message: causeMessage(cause) }),
      });
      const rawConfig = yield* loadConfig(parsed.configPath);
      const instructions = yield* loadInstructions(parsed.instructionsFile);
      const application = yield* makeBroodApplicationFromUnknown(rawConfig);
      return yield* runApplication(application, parsed, {
        goal: parsed.goal,
        ...(instructions === undefined ? {} : { instructions }),
      });
    }),
  );

const matchPublicFailure = Match.type<CliFailure>().pipe(
  Match.tag("AgentFailed", (error) => ({
    code: error._tag,
    failure: error.failure,
    drain: error.drain,
  })),
  Match.tag("RootInterrupted", (error) => ({
    code: error._tag,
    reason: error.reason,
    drain: error.drain,
  })),
  Match.tag("BroodConfigError", (error) => ({
    code: error._tag,
    stage: error.stage,
    reason: error.reason,
    message: error.message,
    path: error.path,
  })),
  Match.tag("RootStartError", (error) => ({
    code: error._tag,
    reason: error.reason,
    message: error.message,
  })),
  Match.tag("CliInputError", (error) => ({
    code: error._tag,
    message: error.message,
  })),
  Match.exhaustive,
);

// A defect-only cause has no typed error to render; everything in the typed
// channel is already a CliFailure, so no runtime tag sniffing is needed.
const reportNonInteractiveExit = (exit: Exit.Exit<unknown, CliFailure>): Effect.Effect<void> => {
  if (process.stdin.isTTY === true || Exit.isSuccess(exit)) return Effect.void;
  if (Cause.hasInterruptsOnly(exit.cause)) return writeJson({ type: "interrupted" });
  return writeJson({
    type: "failed",
    error: Option.match(Cause.findErrorOption(exit.cause), {
      onNone: () => ({ code: "UnexpectedFailure", message: "Brood failed unexpectedly" }),
      onSome: matchPublicFailure,
    }),
  });
};

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

type ShutdownSignal = "SIGINT" | "SIGTERM";

export const exitCodeForSignal = (signal: ShutdownSignal): number =>
  signal === "SIGINT" ? 130 : 143;

if (isMain) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(`${usage}\n`);
  } else {
    const controller = new AbortController();
    let receivedSignal: ShutdownSignal | undefined;
    const interrupt = (signal: ShutdownSignal): void => {
      receivedSignal ??= signal;
      controller.abort();
    };
    const onSigint = (): void => interrupt("SIGINT");
    const onSigterm = (): void => interrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const program = runCli(arguments_).pipe(Effect.onExit(reportNonInteractiveExit));
    void Effect.runPromise(program, { signal: controller.signal })
      .catch((cause: unknown) => {
        if (receivedSignal === undefined && process.stdin.isTTY === true) {
          process.stderr.write(`${causeMessage(cause)}\n`);
        }
        process.exitCode = receivedSignal === undefined ? 1 : exitCodeForSignal(receivedSignal);
      })
      .finally(() => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      });
  }
}
