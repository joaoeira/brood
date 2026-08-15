/**
 * The two Brood control tools (`delegate`, `wait_for_agents`): TypeBox
 * parameter schemas for Pi, Effect-side input normalization, and the
 * Promise bridge into the supervisor's injected `ControlToolPort`.
 *
 * Tools depend only on vocabulary — the supervisor hands its operations in
 * through the port, which is what keeps the module graph acyclic.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema } from "effect";
import { Type } from "typebox";
import {
  AgentName,
  DelegateRejected,
  DelegatedTask,
  ToolInvocationId,
  WaitRejected,
  type AgentId,
  type DelegateError,
  type DelegateToolDetails,
  type DependencyOutcome,
  type WaitToolDetails,
} from "./agent.js";
import type { ProfileCatalogue } from "./profiles.js";

export interface ControlToolPort {
  readonly delegate: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    tasks: ReadonlyArray<DelegatedTask>,
    wait: "all" | "none",
  ) => Effect.Effect<DelegateToolDetails, DelegateError>;
  readonly waitForAgents: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    names: ReadonlyArray<AgentName>,
  ) => Effect.Effect<WaitToolDetails, WaitRejected>;
}

const invalidDelegate = (message: string): DelegateRejected =>
  new DelegateRejected({ reason: "InvalidInput", message });

const decodeInvocationId = Effect.fn("Brood.Tools.decodeInvocationId")(function* <E>(
  value: string,
  onError: (message: string) => E,
) {
  return yield* Schema.decodeUnknownEffect(ToolInvocationId)(value).pipe(
    Effect.mapError((error) => onError(`Invalid tool invocation ID: ${String(error)}`)),
  );
});

const DelegateInput = Schema.Struct({
  tasks: Schema.Array(DelegatedTask).check(Schema.isMinLength(1)),
  wait: Schema.optionalKey(Schema.Literals(["all", "none"])),
});

const WaitForAgentsInput = Schema.Struct({
  children: Schema.Array(AgentName).check(Schema.isMinLength(1)),
});

const strict = { onExcessProperty: "error" as const };
const decodeDelegateInput = Schema.decodeUnknownEffect(DelegateInput, strict);
const decodeWaitForAgentsInput = Schema.decodeUnknownEffect(WaitForAgentsInput, strict);
const EmptyWaitForAgentsInput = Schema.Struct({
  children: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0)),
});
const isEmptyWaitForAgentsInput = Schema.is(EmptyWaitForAgentsInput);

const normalizeDelegateInput = Effect.fn("Brood.Tools.normalizeDelegateInput")(function* (
  input: Parameters<typeof decodeDelegateInput>[0],
  catalogue: ProfileCatalogue,
) {
  return yield* decodeDelegateInput(input).pipe(
    Effect.mapError((error) => invalidDelegate(`Invalid task batch: ${String(error)}`)),
    Effect.flatMap(
      (
        decodedInput,
      ): Effect.Effect<
        { readonly tasks: ReadonlyArray<DelegatedTask>; readonly wait: "all" | "none" },
        DelegateRejected
      > => {
        const tasks = decodedInput.tasks;
        const seen = new Set<AgentName>();
        for (const task of tasks) {
          if (seen.has(task.name)) {
            return Effect.fail(
              invalidDelegate(`Duplicate task name after normalization: ${task.name}`),
            );
          }
          seen.add(task.name);
          if (task.profile !== undefined && Option.isNone(catalogue.get(task.profile))) {
            return Effect.fail(
              new DelegateRejected({
                reason: "UnknownProfile",
                message: `Unknown profile: ${task.profile}. Choose one of: ${catalogue.names.join(", ")}`,
              }),
            );
          }
        }
        return Effect.succeed({ tasks, wait: decodedInput.wait ?? "all" });
      },
    ),
  );
});

const normalizeNames = Effect.fn("Brood.Tools.normalizeNames")(function* (
  input: Parameters<typeof decodeWaitForAgentsInput>[0],
) {
  return yield* decodeWaitForAgentsInput(input).pipe(
    Effect.mapError(
      (error) =>
        new WaitRejected({
          reason: isEmptyWaitForAgentsInput(input) ? "EmptySelection" : "InvalidInput",
          message: `Invalid agent selection: ${String(error)}`,
        }),
    ),
    Effect.map(({ children }) => children),
  );
});

const renderDelegate = (details: DelegateToolDetails): string => {
  const correlations = details.agents.map(
    ({ name, id, profile }) => `- ${name} -> ${id} (profile: ${profile})`,
  );
  const control =
    details.broodControl.kind === "suspend"
      ? "Brood will suspend this agent after every tool call in the current turn completes."
      : "Delegated agents are running independently; this agent will continue.";
  const { limit, used, remaining } = details.admissions;
  return [
    `Delegated batch ${details.batchId}.`,
    ...correlations,
    control,
    `Agent admissions after this batch: ${used} of ${limit} used; ${remaining} remain.`,
    "Remaining admissions are shared globally and may decrease concurrently.",
  ].join("\n");
};

const renderOutcome = (outcome: DependencyOutcome): string => {
  switch (outcome._tag) {
    case "Completed":
      return `- ${outcome.name} (${outcome.agentId}) completed: ${outcome.result.summary}`;
    case "Failed":
      return `- ${outcome.name} (${outcome.agentId}) failed [${outcome.code}]: ${outcome.message}`;
    case "Interrupted":
      return `- ${outcome.name} (${outcome.agentId}) was interrupted [${outcome.reason}]`;
  }
};

const renderWait = (details: WaitToolDetails, names: ReadonlyArray<AgentName>): string =>
  details.broodControl.kind === "suspend"
    ? `Brood will suspend this agent after the current tool batch while waiting for: ${names.join(", ")}.`
    : ["All requested agents are terminal:", ...details.outcomes.map(renderOutcome)].join("\n");

const runTool = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal | undefined): Promise<A> =>
  Effect.runPromise(effect, signal === undefined ? undefined : { signal });

const prepareToolArguments = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

export const compileAgentToolFactory = (catalogue: ProfileCatalogue) => {
  const DelegateParameters = Type.Object(
    {
      tasks: Type.Array(
        Type.Object(
          {
            name: Type.String({
              description: "Unique name for this direct child for the caller's lifetime.",
            }),
            goal: Type.String({ description: "Self-contained goal for the delegated agent." }),
            profile: Type.Optional(
              StringEnum(catalogue.names, {
                description: "Named model profile. Omit to use the run's global default profile.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
      wait: Type.Optional(
        StringEnum(["all", "none"] as const, {
          default: "all",
          description: "Suspend for all new children, or let them run independently.",
        }),
      ),
    },
    { additionalProperties: false },
  );
  const WaitParameters = Type.Object(
    {
      children: Type.Array(Type.String(), {
        minItems: 1,
        description: "Direct-child names created by earlier delegate calls.",
      }),
    },
    { additionalProperties: false },
  );
  const delegateDescription = [
    "Create one or more equally capable agents in one atomic batch.",
    "Children start with no context beyond their goal text: write each goal as a self-contained brief — the background they need, the concrete deliverable, where to leave artifacts under .brood/shared/, what to report back, and when to interrupt you (an urgent send_message or an ask_agent question) instead of pressing on.",
    "The default is wait=all. Use wait=none only for deliberate fire-and-forget work.",
    "Suspension takes effect after every tool call in the current assistant turn completes. Tool calls later in the same turn must not assume delegated results are available.",
    [
      "Each task creates one logical agent and irreversibly consumes one admission from the run-wide pool.",
      "Admissions are shared across every branch, include completed and failed agents, and never replenish during the run.",
      "A batch is all-or-nothing. Use the capacity shown in your runtime context and prior delegate results.",
      "The limit is a safety ceiling, not a target; preserve slack when future work is still uncertain.",
      "Every child receives the same delegation tools and run instructions.",
    ].join(" "),
    catalogue.helpText,
  ].join("\n\n");

  const forCaller = (callerId: AgentId, port: ControlToolPort) => {
    const delegate = defineTool({
      name: "delegate",
      label: "Delegate",
      description: delegateDescription,
      parameters: DelegateParameters,
      prepareArguments: (params) => {
        const input = prepareToolArguments(normalizeDelegateInput(params, catalogue));
        return { tasks: input.tasks.map((task) => ({ ...task })), wait: input.wait };
      },
      executionMode: "sequential",
      async execute(toolCallId, params, signal) {
        const program = Effect.gen(function* () {
          const invocationId = yield* decodeInvocationId(toolCallId, invalidDelegate);
          const input = yield* normalizeDelegateInput(params, catalogue);
          const details = yield* port.delegate(callerId, invocationId, input.tasks, input.wait);
          return {
            content: [{ type: "text" as const, text: renderDelegate(details) }],
            details,
          };
        });
        return runTool(program, signal);
      },
    });

    const wait = defineTool({
      name: "wait_for_agents",
      label: "Wait for agents",
      description:
        "Wait for named direct children created in an earlier turn. The full selection is validated atomically. If any are unfinished, this agent suspends only after every tool call in the current assistant turn completes.",
      parameters: WaitParameters,
      prepareArguments: (params) => ({
        children: [...prepareToolArguments(normalizeNames(params))],
      }),
      executionMode: "sequential",
      async execute(toolCallId, params, signal) {
        const program = Effect.gen(function* () {
          const invocationId = yield* decodeInvocationId(
            toolCallId,
            (message) => new WaitRejected({ reason: "InvalidInput", message }),
          );
          const names = yield* normalizeNames(params);
          const details = yield* port.waitForAgents(callerId, invocationId, names);
          return {
            content: [{ type: "text" as const, text: renderWait(details, names) }],
            details,
          };
        });
        return runTool(program, signal);
      },
    });

    return [delegate, wait] as const;
  };

  return { forCaller } as const;
};

export const makeAgentTools = (
  callerId: AgentId,
  catalogue: ProfileCatalogue,
  port: ControlToolPort,
) => compileAgentToolFactory(catalogue).forCaller(callerId, port);
