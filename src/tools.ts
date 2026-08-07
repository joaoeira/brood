import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema } from "effect";
import { Type } from "typebox";
import {
  AgentId,
  AgentName,
  BatchId,
  BroodControl,
  DelegateRejected,
  DelegatedTask,
  DependencyOutcome,
  ProfileName,
  ToolInvocationId,
  WaitRejected,
  type ProfileCatalogue,
} from "./agent.js";

const DelegatedAgent = Schema.Struct({
  name: AgentName,
  id: AgentId,
  profile: ProfileName,
});

export const DelegateToolDetails = Schema.Struct({
  version: Schema.Literal(1),
  batchId: BatchId,
  agents: Schema.Array(DelegatedAgent),
  broodControl: BroodControl,
});
export interface DelegateToolDetails extends Schema.Schema.Type<typeof DelegateToolDetails> {}

export const WaitToolDetails = Schema.Struct({
  version: Schema.Literal(1),
  outcomes: Schema.Array(DependencyOutcome),
  broodControl: BroodControl,
});
export interface WaitToolDetails extends Schema.Schema.Type<typeof WaitToolDetails> {}

export interface ControlToolPort {
  readonly delegate: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    tasks: ReadonlyArray<DelegatedTask>,
    wait: "all" | "none",
  ) => Effect.Effect<DelegateToolDetails, DelegateRejected>;
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

const normalizeDelegateInput = Effect.fn("Brood.Tools.normalizeDelegateInput")(function* (
  input: unknown,
  catalogue: ProfileCatalogue,
) {
  return yield* Schema.decodeUnknownEffect(DelegateInput)(input).pipe(
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

const normalizeNames = Effect.fn("Brood.Tools.normalizeNames")(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(WaitForAgentsInput)(input).pipe(
    Effect.mapError(
      (error) =>
        new WaitRejected({
          reason:
            typeof input === "object" &&
            input !== null &&
            "children" in input &&
            Array.isArray(input.children) &&
            input.children.length === 0
              ? "EmptySelection"
              : "InvalidInput",
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
  return [`Delegated batch ${details.batchId}.`, ...correlations, control].join("\n");
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
    "The default is wait=all. Use wait=none only for deliberate fire-and-forget work.",
    "Suspension takes effect after every tool call in the current assistant turn completes. Tool calls later in the same turn must not assume delegated results are available.",
    catalogue.helpText,
  ].join("\n\n");

  const forCaller = (callerId: AgentId, port: ControlToolPort) => {
    const delegate = defineTool({
      name: "delegate",
      label: "Delegate",
      description: delegateDescription,
      parameters: DelegateParameters,
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
