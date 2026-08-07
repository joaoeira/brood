/* oxlint-disable no-underscore-dangle -- Effect domain variants intentionally use `_tag`. */
import {
  Cause,
  Effect,
  Exit,
  FiberMap,
  Option,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { Exit as ExitType } from "effect/Exit";
import {
  DelegateRejected,
  PiOpenError,
  PiProtocolError,
  PiRunError,
  UnknownAgent,
  makeAgentName,
  makeBatchId,
  normalizeAgentResult,
  renderAgentCommand,
  type AgentId,
  type AgentName,
  type AgentOutcome,
  type AgentResult,
  type AgentStatus,
  type DelegatedTask,
  type DrainReport,
  type InterruptReason,
  type ProfileCatalogue,
  type PublicModelProfile,
  type ResolvedModelProfile,
  type RootStartError,
  type WaitId,
} from "./agent.js";
import type { PiAdapter, PiAgent, PiOpenRequest, PiSessionEvent } from "./pi-adapter.js";
import {
  makeRegistry,
  type AgentSnapshot,
  type CommandInterrupted,
  type RegisteredAgent,
} from "./registry.js";
import {
  compileAgentToolFactory,
  type ControlToolPort,
  type DelegateToolDetails,
  type WaitToolDetails,
} from "./tools.js";

export interface SupervisorOptions {
  readonly catalogue: ProfileCatalogue;
  readonly piAdapter: PiAdapter;
  readonly maxConcurrency: number;
  readonly maxAgents: number;
  readonly maxAgentResultChars: number;
  readonly maxFailureMessageChars: number;
  readonly maxResumePromptChars: number;
  readonly drainTimeoutMillis: number;
  readonly eventBufferCapacity?: number;
  readonly nextAgentId?: () => AgentId;
  readonly nextWaitId?: () => WaitId;
  readonly nextBatchId?: () => ReturnType<typeof makeBatchId>;
}

export type SupervisorLifecycleEvent =
  | {
      readonly type: "AgentRegistered";
      readonly agentId: AgentId;
      readonly name: AgentName;
      readonly parentId?: AgentId;
      readonly profile: PublicModelProfile;
    }
  | {
      readonly type: "AgentSettled";
      readonly agentId: AgentId;
      readonly status: Extract<AgentStatus, "Completed" | "Failed" | "Interrupted">;
    }
  | {
      readonly type: "AgentInterruptRequested";
      readonly agentId: AgentId;
      readonly reason: InterruptReason;
    }
  | { readonly type: "DrainStarted" }
  | { readonly type: "DrainCompleted"; readonly report: DrainReport };

export type SupervisorEvent =
  | ({ readonly source: "supervisor"; readonly sequence: number } & SupervisorLifecycleEvent)
  | { readonly source: "pi"; readonly event: PiSessionEvent };

export interface AgentSupervisor {
  readonly startRoot: (goal: string) => Effect.Effect<AgentId, RootStartError>;
  readonly awaitOutcome: (id: AgentId) => Effect.Effect<AgentOutcome, UnknownAgent>;
  readonly snapshot: Effect.Effect<ReadonlyArray<AgentSnapshot>>;
  readonly interrupt: (id: AgentId, source: "cli" | "api") => Effect.Effect<void, UnknownAgent>;
  readonly drain: Effect.Effect<DrainReport>;
  readonly events: Stream.Stream<SupervisorEvent>;
  readonly toolPort: ControlToolPort;
}

type ControllerError =
  | PiOpenError
  | PiRunError
  | PiProtocolError
  | UnknownAgent
  | CommandInterrupted;

type RunDisposition =
  | { readonly _tag: "Terminal"; readonly outcome: AgentOutcome }
  | { readonly _tag: "Suspended" };

const isCommandInterrupted = (value: unknown): value is CommandInterrupted =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "CommandInterrupted";

const controllerOutcome = (exit: ExitType<AgentOutcome, ControllerError>): AgentOutcome => {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", reason: { _tag: "SupervisorShutdown" } };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof PiOpenError) {
      return { _tag: "Failed", failure: { _tag: "AgentStartFailed", error } };
    }
    if (error instanceof PiRunError) {
      return { _tag: "Failed", failure: { _tag: "AgentRunFailed", error } };
    }
    if (error instanceof PiProtocolError) {
      return { _tag: "Failed", failure: { _tag: "AgentProtocolFailed", error } };
    }
    if (isCommandInterrupted(error)) {
      return { _tag: "Interrupted", reason: error.reason };
    }
  }
  return { _tag: "Failed", failure: { _tag: "AgentDefect", cause: exit.cause } };
};

const systemPromptFor = (profile: ResolvedModelProfile): string =>
  [
    "You are one agent in a Brood run. The workspace is shared with concurrent agents.",
    `Current profile: ${profile.public.name} (${profile.public.provider}/${profile.public.model}, thinking: ${profile.public.thinkingLevel}).`,
    "Omitting a delegated task profile always uses the run's global default profile, not this profile.",
  ].join("\n");

const terminalStatus = (
  outcome: AgentOutcome,
): Extract<AgentStatus, "Completed" | "Failed" | "Interrupted"> => outcome._tag;

export const makeSupervisor = Effect.fn("Brood.makeSupervisor")(function* (
  options: SupervisorOptions,
) {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
    return yield* Effect.die(new Error("maxConcurrency must be a positive safe integer"));
  }
  if (!Number.isFinite(options.drainTimeoutMillis) || options.drainTimeoutMillis <= 0) {
    return yield* Effect.die(new Error("drainTimeoutMillis must be finite and positive"));
  }
  const eventBufferCapacity = options.eventBufferCapacity ?? 256;
  if (!Number.isSafeInteger(eventBufferCapacity) || eventBufferCapacity <= 0) {
    return yield* Effect.die(new Error("eventBufferCapacity must be a positive safe integer"));
  }

  const registry = yield* makeRegistry({
    maxAgents: options.maxAgents,
    maxFailureMessageChars: options.maxFailureMessageChars,
    ...(options.nextAgentId === undefined ? {} : { nextAgentId: options.nextAgentId }),
    ...(options.nextWaitId === undefined ? {} : { nextWaitId: options.nextWaitId }),
  });
  const slots = yield* Semaphore.make(options.maxConcurrency);
  const controllers = yield* FiberMap.make<AgentId, void, never>();
  const eventBus = yield* PubSub.dropping<SupervisorEvent>(eventBufferCapacity);
  const eventSequence = yield* Ref.make(0);
  const toolFactory = compileAgentToolFactory(options.catalogue);
  const nextBatchId = options.nextBatchId ?? (() => makeBatchId(`batch_${crypto.randomUUID()}`));

  const publishLifecycle = Effect.fn("Brood.Supervisor.publishLifecycle")(
    (event: SupervisorLifecycleEvent) =>
      Ref.updateAndGet(eventSequence, (sequence) => sequence + 1).pipe(
        Effect.tap((sequence) =>
          Effect.sync(() => {
            PubSub.publishUnsafe(eventBus, { source: "supervisor", sequence, ...event });
          }),
        ),
        Effect.asVoid,
      ),
  );

  const publishPiEvent = Effect.fn("Brood.Supervisor.publishPiEvent")((event: PiSessionEvent) =>
    Effect.sync(() => {
      PubSub.publishUnsafe(eventBus, { source: "pi", event });
    }),
  );

  const publishRegistration = (registration: RegisteredAgent): Effect.Effect<void> =>
    publishLifecycle({
      type: "AgentRegistered",
      agentId: registration.id,
      name: registration.name,
      ...(registration.parentId === undefined ? {} : { parentId: registration.parentId }),
      profile: registration.profile,
    });

  const publishSettlement = Effect.fn("Brood.Supervisor.publishSettlement")(function* (
    id: AgentId,
  ) {
    const outcome = yield* registry.awaitOutcome(id).pipe(Effect.orDie);
    yield* publishLifecycle({
      type: "AgentSettled",
      agentId: id,
      status: terminalStatus(outcome),
    });
  });

  const publishInterruptions = (
    ids: ReadonlyArray<AgentId>,
    reason: InterruptReason,
  ): Effect.Effect<void> =>
    Effect.forEach(
      ids,
      (agentId) => publishLifecycle({ type: "AgentInterruptRequested", agentId, reason }),
      { discard: true },
    );

  const disposition = Effect.fn("Brood.Supervisor.acceptRunOutcome")(function* (
    id: AgentId,
    agent: PiAgent,
    outcome: import("./agent.js").PiRunOutcome,
  ) {
    if (outcome._tag === "Completed") {
      const result: AgentResult = normalizeAgentResult(
        id,
        agent.sessionId,
        outcome.result.finalText,
        options.maxAgentResultChars,
      );
      return { _tag: "Terminal", outcome: { _tag: "Completed", result } } satisfies RunDisposition;
    }
    yield* registry.activateWaits(id);
    return { _tag: "Suspended" } satisfies RunDisposition;
  });

  function controllerBody(
    registration: RegisteredAgent,
    profile: ResolvedModelProfile,
  ): Effect.Effect<AgentOutcome, ControllerError, Scope.Scope> {
    return Effect.gen(function* () {
      const controllerScope = yield* Effect.scope;
      const first = yield* registry.takePendingCommand(registration.id);
      const opened = yield* slots.withPermit(
        Effect.gen(function* () {
          yield* registry.markStarting(registration.id);
          const request: PiOpenRequest = {
            agentId: registration.id,
            profile,
            tools: toolFactory.forCaller(registration.id, toolPort),
            systemPrompt: systemPromptFor(profile),
          };
          const agent = yield* Scope.provide(controllerScope)(options.piAdapter.open(request));
          yield* agent.events.pipe(Stream.runForEach(publishPiEvent), Effect.forkScoped);
          yield* registry.markRunning(registration.id);
          const outcome = yield* agent.run(renderAgentCommand(first, options.maxResumePromptChars));
          const next = yield* disposition(registration.id, agent, outcome);
          return { agent, next };
        }),
      );
      if (opened.next._tag === "Terminal") return opened.next.outcome;

      while (true) {
        const command = yield* registry.takePendingCommand(registration.id);
        const next = yield* slots.withPermit(
          Effect.gen(function* () {
            yield* registry.markRunning(registration.id);
            const outcome = yield* opened.agent.run(
              renderAgentCommand(command, options.maxResumePromptChars),
            );
            return yield* disposition(registration.id, opened.agent, outcome);
          }),
        );
        if (next._tag === "Terminal") return next.outcome;
      }
    });
  }

  function controller(
    registration: RegisteredAgent,
    profile: ResolvedModelProfile,
  ): Effect.Effect<void> {
    const body = controllerBody(registration, profile).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const settled = yield* registry
            .settle(registration.id, controllerOutcome(exit))
            .pipe(Effect.orDie);
          if (settled) yield* publishSettlement(registration.id);
        }),
      ),
      Effect.exit,
      Effect.asVoid,
    );
    return Effect.scoped(body);
  }

  const installController = Effect.fn("Brood.Supervisor.installController")(function* (
    registration: RegisteredAgent,
    profile: ResolvedModelProfile,
  ) {
    yield* FiberMap.run(controllers, registration.id, controller(registration, profile), {
      onlyIfMissing: true,
    });
    yield* registry.markInstalled(registration.id).pipe(Effect.orDie);
  });

  const resolveTasks = Effect.fn("Brood.Supervisor.resolveTasks")(function* (
    tasks: ReadonlyArray<DelegatedTask>,
  ) {
    const resolved: Array<{
      readonly task: DelegatedTask;
      readonly profile: ResolvedModelProfile;
    }> = [];
    for (const task of tasks) {
      const profile =
        task.profile === undefined
          ? options.catalogue.defaultProfile
          : Option.getOrUndefined(options.catalogue.get(task.profile));
      if (profile === undefined) {
        return yield* Effect.fail(
          new DelegateRejected({
            reason: "UnknownProfile",
            message: `Unknown profile: ${task.profile}`,
          }),
        );
      }
      resolved.push({ task, profile });
    }
    return resolved;
  });

  const toolPort: ControlToolPort = {
    delegate: Effect.fn("Brood.Supervisor.delegate")(
      function* (callerId, invocationId, tasks, wait) {
        const resolved = yield* resolveTasks(tasks);
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const batch = yield* registry
              .registerBatch({
                parentId: callerId,
                invocationId,
                children: resolved.map(({ task, profile }) => ({
                  name: task.name,
                  goal: task.goal,
                  profile: profile.public,
                })),
                wait,
              })
              .pipe(Effect.catchTag("UnknownAgent", Effect.die));
            yield* Effect.forEach(batch.children, publishRegistration, { discard: true });
            for (let index = 0; index < batch.children.length; index += 1) {
              const child = batch.children[index];
              const childProfile = resolved[index]?.profile;
              if (child === undefined || childProfile === undefined) {
                return yield* Effect.die(
                  new Error("Registry batch did not preserve resolved child correlation"),
                );
              }
              yield* installController(child, childProfile);
            }
            const details: DelegateToolDetails = {
              version: 1,
              batchId: nextBatchId(),
              agents: batch.children.map((child) => ({
                name: child.name,
                id: child.id,
                profile: child.profile.name,
              })),
              broodControl: {
                version: 1,
                kind: wait === "all" ? "suspend" : "continue",
                invocationId,
              },
            };
            return details;
          }),
        );
      },
    ),
    waitForAgents: Effect.fn("Brood.Supervisor.waitForAgents")(
      function* (callerId, invocationId, names) {
        const planned = yield* registry
          .planWait({ parentId: callerId, invocationId, childNames: names })
          .pipe(Effect.catchTag("UnknownAgent", Effect.die));
        const details: WaitToolDetails = {
          version: 1,
          outcomes: planned._tag === "Ready" ? planned.outcomes : [],
          broodControl: {
            version: 1,
            kind: planned._tag === "Ready" ? "continue" : "suspend",
            invocationId,
          },
        };
        return details;
      },
    ),
  };

  const startRoot = Effect.fn("Brood.Supervisor.startRoot")((goal: string) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const registration = yield* registry.registerRoot({
          name: makeAgentName("root"),
          goal,
          profile: options.catalogue.rootProfile.public,
        });
        yield* publishRegistration(registration);
        yield* installController(registration, options.catalogue.rootProfile);
        return registration.id;
      }),
    ),
  );

  const interrupt = Effect.fn("Brood.Supervisor.interrupt")(function* (
    id: AgentId,
    source: "cli" | "api",
  ) {
    const reason: InterruptReason = { _tag: "OperatorRequested", source };
    const requested = yield* registry.requestInterrupt(id, reason);
    if (requested) yield* publishInterruptions([id], reason);
    yield* FiberMap.remove(controllers, id);
  });

  const drain = Effect.fn("Brood.Supervisor.drain")(function* () {
    yield* publishLifecycle({ type: "DrainStarted" });
    const quiescent = yield* registry.awaitQuiescence.pipe(
      Effect.timeoutOption(options.drainTimeoutMillis),
    );
    let interruptedAgentIds: ReadonlyArray<AgentId> = [];
    if (Option.isNone(quiescent)) {
      const reason: InterruptReason = {
        _tag: "DrainTimeout",
        timeoutMillis: options.drainTimeoutMillis,
      };
      interruptedAgentIds = yield* registry.beginShutdown(reason);
      yield* publishInterruptions(interruptedAgentIds, reason);
      const settledPending = yield* registry.settlePendingInstallations(reason);
      yield* Effect.forEach(settledPending, publishSettlement, { discard: true });
      yield* Effect.forEach(interruptedAgentIds, (id) => FiberMap.remove(controllers, id), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* registry.awaitQuiescence;
    }
    yield* FiberMap.awaitEmpty(controllers);
    const state = yield* registry.snapshot;
    const report: DrainReport = {
      timedOut: Option.isNone(quiescent),
      interruptedAgentIds,
      terminalAgentCount: state.agents.filter(({ outcome }) => outcome !== undefined).length,
    };
    yield* publishLifecycle({ type: "DrainCompleted", report });
    return report;
  })();

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const reason: InterruptReason = { _tag: "SupervisorShutdown" };
      const interruptedAgentIds = yield* registry.beginShutdown(reason);
      yield* publishInterruptions(interruptedAgentIds, reason);
      const settledPending = yield* registry.settlePendingInstallations(reason);
      yield* Effect.forEach(settledPending, publishSettlement, { discard: true });
      yield* FiberMap.clear(controllers);
      yield* PubSub.shutdown(eventBus);
    }),
  );

  return {
    startRoot,
    awaitOutcome: registry.awaitOutcome,
    snapshot: registry.snapshot.pipe(Effect.map(({ agents }) => agents)),
    interrupt,
    drain,
    events: Stream.fromPubSub(eventBus),
    toolPort,
  } satisfies AgentSupervisor;
});
