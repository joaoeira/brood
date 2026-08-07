#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Cause, Data, Effect, Exit, Option, Queue, Ref, Stream } from "effect";
import { makeAgentId, type AgentId } from "./agent.js";
import { makeBroodApplicationFromUnknown, type BroodApplication } from "./main.js";

export interface CliArguments {
  readonly configPath: string;
  readonly goal: string;
  readonly showEvents: boolean;
}

type OperatorCommand =
  | { readonly _tag: "Status" }
  | { readonly _tag: "Interrupt"; readonly agentId: AgentId }
  | { readonly _tag: "Events"; readonly enabled: boolean }
  | { readonly _tag: "Help" };

class CliInputError extends Data.TaggedError("CliInputError")<{
  readonly message: string;
}> {}

const usage =
  'Usage: brood --config <brood.json> [--events] --goal "<goal>"\n' +
  "       brood --config <brood.json> [--events] <goal...>";

export const parseCliArguments = (arguments_: ReadonlyArray<string>): CliArguments => {
  let configPath: string | undefined;
  let explicitGoal: string | undefined;
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

  const goal = (explicitGoal ?? positional.join(" ")).trim();
  if (configPath === undefined || configPath.trim() === "") {
    throw new CliInputError({ message: `Missing --config.\n${usage}` });
  }
  if (goal === "") throw new CliInputError({ message: `Missing goal.\n${usage}` });
  return { configPath: resolve(configPath), goal, showEvents };
};

export const parseOperatorCommand = (line: string): OperatorCommand => {
  const [command, ...rest] = line.trim().split(/\s+/);
  switch (command) {
    case "status":
      return { _tag: "Status" };
    case "interrupt": {
      const raw = rest[0];
      if (raw === undefined || rest.length !== 1) {
        throw new CliInputError({ message: "Usage: interrupt <agent-id>" });
      }
      try {
        return { _tag: "Interrupt", agentId: makeAgentId(raw) };
      } catch {
        throw new CliInputError({ message: `Invalid agent ID: ${raw}` });
      }
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
        message: `Unable to read config ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) =>
          new CliInputError({
            message: `Invalid JSON in ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
    const command = yield* Effect.try({
      try: () => parseOperatorCommand(line),
      catch: (cause) =>
        cause instanceof CliInputError
          ? cause
          : new CliInputError({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    switch (command._tag) {
      case "Status": {
        const agents = yield* application.controller.snapshot;
        yield* writeJson({ type: "status", agents });
        break;
      }
      case "Interrupt":
        yield* application.controller.interrupt(command.agentId, "cli");
        yield* writeJson({ type: "interrupt-requested", agentId: command.agentId });
        break;
      case "Events":
        yield* Ref.set(eventDisplay, command.enabled);
        yield* writeMessage(`Event display ${command.enabled ? "enabled" : "disabled"}.`);
        break;
      case "Help":
        yield* writeMessage("Commands: status | interrupt <agent-id> | events on|off | help");
        break;
    }
  }).pipe(
    Effect.catch((cause) => writeMessage(cause instanceof Error ? cause.message : String(cause))),
  );

const runApplication = (application: BroodApplication, arguments_: CliArguments) =>
  Effect.gen(function* () {
    const interactive = process.stdin.isTTY === true;
    const eventDisplay = yield* Ref.make(!interactive || arguments_.showEvents);

    yield* application.controller.events.pipe(
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
        "Brood is running. Commands: status | interrupt <agent-id> | events on|off",
      );
      yield* commandLines().pipe(
        Stream.runForEach((line) => executeCommand(application, eventDisplay, line)),
        Effect.forkScoped,
      );
    }
    yield* Effect.yieldNow;
    const result = yield* application.run(arguments_.goal);
    yield* writeJson({ type: "completed", result });
    return result;
  });

export const runCli = (arguments_: ReadonlyArray<string>): Effect.Effect<unknown, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => parseCliArguments(arguments_),
        catch: (cause) => cause,
      });
      const rawConfig = yield* loadConfig(parsed.configPath);
      const application = yield* makeBroodApplicationFromUnknown(rawConfig);
      return yield* runApplication(application, parsed);
    }),
  );

const publicFailure = (error: unknown): Readonly<Record<string, unknown>> => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return { code: "UnexpectedFailure", message: "Brood failed unexpectedly" };
  }
  const tagged = Object.fromEntries(Object.entries(error));
  const code = typeof tagged._tag === "string" ? tagged._tag : "UnexpectedFailure";
  const message =
    typeof tagged.message === "string"
      ? tagged.message
      : error instanceof Error
        ? error.message
        : "Brood failed";
  switch (code) {
    case "AgentFailed":
      return { code, failure: tagged.failure, drain: tagged.drain };
    case "RootInterrupted":
      return { code, reason: tagged.reason, drain: tagged.drain };
    case "BroodConfigError":
      return {
        code,
        stage: tagged.stage,
        reason: tagged.reason,
        message,
        path: tagged.path,
      };
    case "RootStartError":
    case "CliInputError":
      return { code, message };
    default:
      return { code, message: "Brood failed" };
  }
};

const reportNonInteractiveExit = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
  if (process.stdin.isTTY === true || Exit.isSuccess(exit)) return Effect.void;
  if (Cause.hasInterruptsOnly(exit.cause)) return writeJson({ type: "interrupted" });
  const error = Cause.findErrorOption(exit.cause);
  return writeJson({
    type: "failed",
    error: Option.isSome(error) ? publicFailure(error.value) : publicFailure(undefined),
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
          process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
        process.exitCode = receivedSignal === undefined ? 1 : exitCodeForSignal(receivedSignal);
      })
      .finally(() => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      });
  }
}
