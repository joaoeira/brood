import { Clock, Data, Deferred, Effect, Latch, Option, Ref, Result } from "effect";
import type { Deferred as DeferredType } from "effect/Deferred";
import type { Latch as LatchType } from "effect/Latch";
/* oxlint-disable no-underscore-dangle -- Effect domain variants intentionally use `_tag`. */
import {
  DelegateRejected,
  DEFAULT_MAX_FAILURE_MESSAGE_CHARS,
  RootStartError,
  UnknownAgent,
  WaitRejected,
  dependencyOutcomeFromAgent,
  makeAgentId,
  makeWaitId,
  type AgentCommand,
  type AgentId,
  type AgentName,
  type AgentOutcome,
  type AgentStatus,
  type DependencyOutcome,
  type InterruptReason,
  type PublicModelProfile,
  type ToolInvocationId,
  type WaitId,
} from "./agent.js";

export type InstallationStatus = "Pending" | "Installed";

export interface RegisteredAgent {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly parentId: AgentId | undefined;
  readonly profile: PublicModelProfile;
}

export interface RegisterAgentInput {
  readonly name: AgentName;
  readonly goal: string;
  readonly profile: PublicModelProfile;
}

export type RegisterRootInput = RegisterAgentInput;
export type RegisterChildInput = RegisterAgentInput;

export interface RegisterBatchInput {
  readonly parentId: AgentId;
  readonly invocationId: ToolInvocationId;
  readonly children: ReadonlyArray<RegisterChildInput>;
  readonly wait: "all" | "none";
}

export interface BatchRegistration {
  readonly children: ReadonlyArray<RegisteredAgent>;
}

export interface PlanWaitInput {
  readonly parentId: AgentId;
  readonly invocationId: ToolInvocationId;
  readonly childNames: ReadonlyArray<AgentName>;
}

export type WaitPlanResult =
  | {
      readonly _tag: "Ready";
      readonly outcomes: ReadonlyArray<DependencyOutcome>;
    }
  | { readonly _tag: "Planned"; readonly targetIds: ReadonlyArray<AgentId> };

export type WaitActivation =
  | {
      readonly _tag: "Waiting";
      readonly waitId: WaitId;
      readonly targetIds: ReadonlyArray<AgentId>;
    }
  | {
      readonly _tag: "Resumed";
      readonly waitId: WaitId;
      readonly targetIds: ReadonlyArray<AgentId>;
    };

export interface CommandInterrupted {
  readonly _tag: "CommandInterrupted";
  readonly agentId: AgentId;
  readonly reason: InterruptReason;
}

export interface CommittedInterruptRequest {
  readonly agentId: AgentId;
  readonly reason: InterruptReason;
}

export interface ShutdownResult {
  readonly activeIds: ReadonlyArray<AgentId>;
  readonly newlyRequested: ReadonlyArray<CommittedInterruptRequest>;
}

export interface CommittedSettlement {
  readonly agentId: AgentId;
  readonly outcome: AgentOutcome;
}

export class RegistryInvariantDefect extends Error {}

// Transition bodies run inside pure Ref.modify callbacks. Throwing here deliberately turns an
// impossible registry state into a defect; domain rejection belongs in Transition.result instead.

export interface AgentSnapshot extends RegisteredAgent {
  readonly status: AgentStatus;
  readonly installation: InstallationStatus;
  readonly waitTargets: ReadonlyArray<AgentId>;
  readonly hasPendingCommand: boolean;
  readonly interruptRequested: InterruptReason | undefined;
  readonly outcome: AgentOutcome | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | undefined;
}

export interface RegistrySnapshot {
  readonly agents: ReadonlyArray<AgentSnapshot>;
  readonly rootId: AgentId | undefined;
  readonly accepting: boolean;
  readonly nonterminalCount: number;
  readonly pendingInstallationCount: number;
}

interface ActiveWait {
  readonly waitId: WaitId;
  readonly targetIds: ReadonlyArray<AgentId>;
}

interface AgentEntry extends RegisteredAgent {
  readonly status: AgentStatus;
  readonly installation: InstallationStatus;
  readonly pendingCommand: AgentCommand | undefined;
  readonly mailbox: LatchType;
  readonly completion: DeferredType<AgentOutcome>;
  readonly outcome: AgentOutcome | undefined;
  readonly interruptRequested: InterruptReason | undefined;
  readonly seenInvocations: ReadonlySet<ToolInvocationId>;
  readonly plannedTargets: ReadonlyArray<AgentId>;
  readonly activeWait: ActiveWait | undefined;
  readonly childrenByName: ReadonlyMap<AgentName, AgentId>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | undefined;
}

interface RegistryState {
  readonly agents: ReadonlyMap<AgentId, AgentEntry>;
  readonly rootId: AgentId | undefined;
  readonly accepting: boolean;
  readonly nonterminalCount: number;
}

type PostCommitAction = Data.TaggedEnum<{
  Complete: {
    readonly deferred: DeferredType<AgentOutcome>;
    readonly outcome: AgentOutcome;
  };
  Open: { readonly latch: LatchType };
}>;

const PostCommitAction = Data.taggedEnum<PostCommitAction>();

interface Transition<A, E> {
  readonly next: RegistryState;
  readonly actions: ReadonlyArray<PostCommitAction>;
  readonly result: Result.Result<A, E>;
}

const noChange = <A, E>(state: RegistryState, result: Result.Result<A, E>): Transition<A, E> => ({
  next: state,
  actions: [],
  result,
});

const replaceAgent = (state: RegistryState, entry: AgentEntry): RegistryState => {
  const agents = new Map(state.agents);
  agents.set(entry.id, entry);
  return { ...state, agents };
};

const waitTargets = (entry: AgentEntry): ReadonlyArray<AgentId> => {
  if (entry.activeWait !== undefined) return [...entry.activeWait.targetIds];
  return [...entry.plannedTargets];
};

const withTargets = (
  current: ReadonlyArray<AgentId>,
  additions: ReadonlyArray<AgentId>,
): ReadonlyArray<AgentId> => {
  const selected = new Set(current);
  const targetIds = [...current];
  for (const targetId of additions) {
    if (selected.has(targetId)) continue;
    selected.add(targetId);
    targetIds.push(targetId);
  }
  return targetIds;
};

const dispatchAction = (action: PostCommitAction): Effect.Effect<void> =>
  PostCommitAction.$match(action, {
    Complete: ({ deferred, outcome }) => Deferred.succeed(deferred, outcome).pipe(Effect.asVoid),
    Open: ({ latch }) => Latch.open(latch).pipe(Effect.asVoid),
  });

export interface RegistryOptions {
  readonly maxAgents: number;
  readonly maxFailureMessageChars?: number;
  readonly nextAgentId?: () => AgentId;
  readonly nextWaitId?: () => WaitId;
}

export interface AgentRegistry {
  readonly registerRoot: (
    input: RegisterRootInput,
  ) => Effect.Effect<RegisteredAgent, RootStartError>;
  readonly registerBatch: (
    input: RegisterBatchInput,
  ) => Effect.Effect<BatchRegistration, DelegateRejected | UnknownAgent>;
  readonly settle: (
    id: AgentId,
    outcome: AgentOutcome,
  ) => Effect.Effect<Option.Option<AgentOutcome>, UnknownAgent>;
  readonly planWait: (
    input: PlanWaitInput,
  ) => Effect.Effect<WaitPlanResult, WaitRejected | UnknownAgent>;
  readonly activateWaits: (id: AgentId) => Effect.Effect<WaitActivation, UnknownAgent>;
  readonly markInstalled: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly markStarting: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly markRunning: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly takePendingCommand: (
    id: AgentId,
  ) => Effect.Effect<AgentCommand, UnknownAgent | CommandInterrupted>;
  readonly awaitOutcome: (id: AgentId) => Effect.Effect<AgentOutcome, UnknownAgent>;
  readonly requestInterrupt: (
    id: AgentId,
    reason: InterruptReason,
  ) => Effect.Effect<boolean, UnknownAgent>;
  readonly beginShutdown: (reason: InterruptReason) => Effect.Effect<ShutdownResult>;
  readonly settlePendingInstallations: (
    reason: InterruptReason,
  ) => Effect.Effect<ReadonlyArray<CommittedSettlement>>;
  readonly awaitQuiescence: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<RegistrySnapshot>;
}

const makeEntry = (
  registration: RegisteredAgent,
  goal: string,
  now: number,
  mailbox: LatchType,
  completion: DeferredType<AgentOutcome>,
): AgentEntry => ({
  ...registration,
  status: "Queued",
  installation: "Pending",
  pendingCommand: { _tag: "InitialGoal", goal },
  mailbox,
  completion,
  outcome: undefined,
  interruptRequested: undefined,
  seenInvocations: new Set(),
  plannedTargets: [],
  activeWait: undefined,
  childrenByName: new Map(),
  createdAt: now,
  updatedAt: now,
  terminalAt: undefined,
});

export const makeRegistry = Effect.fn("Brood.makeRegistry")(function* (options: RegistryOptions) {
  const maxAgents = options.maxAgents;
  if (!Number.isSafeInteger(maxAgents) || maxAgents <= 0) {
    return yield* Effect.die(new Error("Registry maxAgents must be a positive safe integer"));
  }

  const maxFailureMessageChars =
    options.maxFailureMessageChars ?? DEFAULT_MAX_FAILURE_MESSAGE_CHARS;
  const nextAgentId = options.nextAgentId ?? (() => makeAgentId(`agent_${crypto.randomUUID()}`));
  const nextWaitId = options.nextWaitId ?? (() => makeWaitId(`wait_${crypto.randomUUID()}`));
  const quiescence = yield* Latch.make(false);
  const stateRef = yield* Ref.make<RegistryState>({
    agents: new Map(),
    rootId: undefined,
    accepting: true,
    nonterminalCount: 0,
  });

  const transact = <A, E>(
    transition: (state: RegistryState) => Transition<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.uninterruptible(
      Ref.modify(stateRef, (state) => {
        const committed = transition(state);
        return [committed, committed.next];
      }).pipe(
        Effect.flatMap((committed) =>
          Effect.forEach(committed.actions, dispatchAction, { discard: true }).pipe(
            Effect.andThen(Effect.fromResult(committed.result)),
          ),
        ),
      ),
    );

  const withAgent = <A, E>(
    state: RegistryState,
    id: AgentId,
    body: (entry: AgentEntry) => Transition<A, E>,
  ): Transition<A, E | UnknownAgent> => {
    const entry = state.agents.get(id);
    return entry === undefined
      ? noChange(state, Result.fail(new UnknownAgent({ agentId: id })))
      : body(entry);
  };

  const outcomesFor = (
    state: RegistryState,
    targetIds: ReadonlyArray<AgentId>,
  ): ReadonlyArray<DependencyOutcome> =>
    targetIds.map((targetId) => {
      const target = state.agents.get(targetId);
      if (target === undefined || target.outcome === undefined) {
        throw new RegistryInvariantDefect(`Wait target ${targetId} is not terminal`);
      }
      return dependencyOutcomeFromAgent(
        target.id,
        target.name,
        target.outcome,
        maxFailureMessageChars,
      );
    });

  const registerRoot = Effect.fn("Brood.Registry.registerRoot")(function* (
    input: RegisterRootInput,
  ) {
    const id = nextAgentId();
    const mailbox = yield* Latch.make(false);
    const completion = yield* Deferred.make<AgentOutcome>();
    const registeredAt = yield* Clock.currentTimeMillis;
    const registered: RegisteredAgent = {
      id,
      name: input.name,
      parentId: undefined,
      profile: input.profile,
    };
    const entry = makeEntry(registered, input.goal, registeredAt, mailbox, completion);

    return yield* transact((state): Transition<RegisteredAgent, RootStartError> => {
      if (!state.accepting || state.rootId !== undefined) {
        return noChange(
          state,
          Result.fail(
            new RootStartError({
              message: "This registry has already admitted or closed its root",
            }),
          ),
        );
      }
      const agents = new Map(state.agents);
      agents.set(id, entry);
      return {
        next: {
          ...state,
          agents,
          rootId: id,
          nonterminalCount: 1,
        },
        actions: [PostCommitAction.Open({ latch: mailbox })],
        result: Result.succeed(registered),
      };
    });
  });

  const registerBatch = Effect.fn("Brood.Registry.registerBatch")(function* (
    input: RegisterBatchInput,
  ) {
    const registeredAt = yield* Clock.currentTimeMillis;
    const prepared = yield* Effect.forEach(input.children, (child) =>
      Effect.gen(function* () {
        const registered: RegisteredAgent = {
          id: nextAgentId(),
          name: child.name,
          parentId: input.parentId,
          profile: child.profile,
        };
        const mailbox = yield* Latch.make(false);
        const completion = yield* Deferred.make<AgentOutcome>();
        return {
          registered,
          entry: makeEntry(registered, child.goal, registeredAt, mailbox, completion),
        };
      }),
    );

    return yield* transact(
      (state): Transition<BatchRegistration, DelegateRejected | UnknownAgent> => {
        return withAgent<BatchRegistration, DelegateRejected>(state, input.parentId, (parent) => {
          if (!state.accepting) {
            return noChange(
              state,
              Result.fail(
                new DelegateRejected({
                  reason: "NotAccepting",
                  message: "The registry is shutting down",
                }),
              ),
            );
          }
          if (parent.outcome !== undefined) {
            return noChange(
              state,
              Result.fail(
                new DelegateRejected({
                  reason: "InvalidInput",
                  message: "A terminal agent cannot delegate",
                }),
              ),
            );
          }
          if (parent.seenInvocations.has(input.invocationId)) {
            return noChange(
              state,
              Result.fail(
                new DelegateRejected({
                  reason: "DuplicateInvocationId",
                  message: `Control invocation ${input.invocationId} was already committed`,
                }),
              ),
            );
          }
          if (input.children.length === 0) {
            return noChange(
              state,
              Result.fail(
                new DelegateRejected({
                  reason: "InvalidInput",
                  message: "Delegation requires at least one child",
                }),
              ),
            );
          }
          if (state.agents.size + input.children.length > maxAgents) {
            return noChange(
              state,
              Result.fail(
                new DelegateRejected({
                  reason: "AgentLimitExceeded",
                  message: `Agent limit ${maxAgents} would be exceeded by ${input.children.length} requested children`,
                }),
              ),
            );
          }

          if (prepared.length !== input.children.length) {
            throw new RegistryInvariantDefect("Prepared child batch changed length");
          }
          const names = new Set<AgentName>();
          const ids = new Set<AgentId>();
          for (let index = 0; index < input.children.length; index += 1) {
            const child = input.children[index];
            const preparedChild = prepared[index];
            if (child === undefined || preparedChild === undefined) {
              throw new RegistryInvariantDefect("Prepared child batch lost an indexed entry");
            }
            if (names.has(child.name) || parent.childrenByName.has(child.name)) {
              return noChange(
                state,
                Result.fail(
                  new DelegateRejected({
                    reason: "NameCollision",
                    message: `Direct-child name ${child.name} has already been used`,
                  }),
                ),
              );
            }
            names.add(child.name);
            if (
              ids.has(preparedChild.registered.id) ||
              state.agents.has(preparedChild.registered.id)
            ) {
              throw new RegistryInvariantDefect(
                `Agent ID generator reused ${preparedChild.registered.id}`,
              );
            }
            ids.add(preparedChild.registered.id);
          }

          const agents = new Map(state.agents);
          const childrenByName = new Map(parent.childrenByName);
          for (const child of prepared) {
            agents.set(child.registered.id, child.entry);
            childrenByName.set(child.registered.name, child.registered.id);
          }
          const seenInvocations = new Set(parent.seenInvocations);
          seenInvocations.add(input.invocationId);
          const plannedTargets =
            input.wait === "all"
              ? withTargets(
                  parent.plannedTargets,
                  prepared.map(({ registered }) => registered.id),
                )
              : parent.plannedTargets;
          agents.set(parent.id, {
            ...parent,
            childrenByName,
            seenInvocations,
            plannedTargets,
            updatedAt: registeredAt,
          });

          return {
            next: {
              ...state,
              agents,
              nonterminalCount: state.nonterminalCount + prepared.length,
            },
            actions: prepared.map(({ entry }) => PostCommitAction.Open({ latch: entry.mailbox })),
            result: Result.succeed({
              children: prepared.map(({ registered }) => registered),
            }),
          };
        });
      },
    );
  });

  const planWait = Effect.fn("Brood.Registry.planWait")(function* (input: PlanWaitInput) {
    const plannedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<WaitPlanResult, WaitRejected | UnknownAgent> =>
      withAgent<WaitPlanResult, WaitRejected>(state, input.parentId, (parent) => {
        if (parent.seenInvocations.has(input.invocationId)) {
          return noChange(
            state,
            Result.fail(
              new WaitRejected({
                reason: "DuplicateInvocationId",
                message: `Control invocation ${input.invocationId} was already committed`,
              }),
            ),
          );
        }
        if (input.childNames.length === 0) {
          return noChange(
            state,
            Result.fail(
              new WaitRejected({
                reason: "EmptySelection",
                message: "A wait requires at least one child",
              }),
            ),
          );
        }
        if (parent.outcome !== undefined) {
          return noChange(
            state,
            Result.fail(
              new WaitRejected({ reason: "UnknownChild", message: "A terminal agent cannot wait" }),
            ),
          );
        }

        const targetIds: Array<AgentId> = [];
        const selected = new Set<AgentId>();
        for (const name of input.childNames) {
          const childId = parent.childrenByName.get(name);
          if (childId === undefined) {
            return noChange(
              state,
              Result.fail(
                new WaitRejected({
                  reason: "UnknownChild",
                  message: `${name} is not a direct child of ${parent.name}`,
                }),
              ),
            );
          }
          if (!selected.has(childId)) {
            selected.add(childId);
            targetIds.push(childId);
          }
        }

        const seenInvocations = new Set(parent.seenInvocations);
        seenInvocations.add(input.invocationId);
        const canonicalTargetIds = [...targetIds];
        const allTerminal = canonicalTargetIds.every((targetId) => {
          const target = state.agents.get(targetId);
          return target !== undefined && target.outcome !== undefined;
        });
        const next = replaceAgent(state, {
          ...parent,
          seenInvocations,
          plannedTargets: allTerminal
            ? parent.plannedTargets
            : withTargets(parent.plannedTargets, canonicalTargetIds),
          updatedAt: plannedAt,
        });

        return {
          next,
          actions: [],
          result: Result.succeed(
            allTerminal
              ? {
                  _tag: "Ready",
                  outcomes: outcomesFor(state, canonicalTargetIds),
                }
              : { _tag: "Planned", targetIds: canonicalTargetIds },
          ),
        };
      }),
    );
  });

  const activateWaits = Effect.fn("Brood.Registry.activateWaits")(function* (id: AgentId) {
    const waitId = nextWaitId();
    const activatedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<WaitActivation, UnknownAgent> =>
      withAgent<WaitActivation, never>(state, id, (parent) => {
        if (parent.status !== "Running") {
          throw new RegistryInvariantDefect(
            `Cannot activate waits for ${id} while ${parent.status}`,
          );
        }
        if (parent.plannedTargets.length === 0) {
          throw new RegistryInvariantDefect(`Suspended agent ${id} has no planned waits`);
        }
        if (parent.pendingCommand !== undefined || parent.activeWait !== undefined) {
          throw new RegistryInvariantDefect(`Agent ${id} already has active mailbox or wait state`);
        }

        const canonicalTargetIds = [...parent.plannedTargets];

        const allTerminal = canonicalTargetIds.every(
          (targetId) => state.agents.get(targetId)?.outcome !== undefined,
        );
        if (allTerminal) {
          const command: AgentCommand = {
            _tag: "Resume",
            waitId,
            outcomes: outcomesFor(state, canonicalTargetIds),
          };
          const next = replaceAgent(state, {
            ...parent,
            status: "Queued",
            pendingCommand: command,
            plannedTargets: [],
            activeWait: undefined,
            updatedAt: activatedAt,
          });
          return {
            next,
            actions: [PostCommitAction.Open({ latch: parent.mailbox })],
            result: Result.succeed({ _tag: "Resumed", waitId, targetIds: canonicalTargetIds }),
          };
        }

        const activeWait: ActiveWait = { waitId, targetIds: canonicalTargetIds };
        const next = replaceAgent(state, {
          ...parent,
          status: "Waiting",
          plannedTargets: [],
          activeWait,
          updatedAt: activatedAt,
        });
        return {
          next,
          actions: [],
          result: Result.succeed({ _tag: "Waiting", waitId, targetIds: canonicalTargetIds }),
        };
      }),
    );
  });

  const markInstalled = Effect.fn("Brood.Registry.markInstalled")(function* (id: AgentId) {
    const installedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<void, UnknownAgent> =>
      withAgent<void, never>(state, id, (entry) => {
        if (entry.installation === "Installed") return noChange(state, Result.succeed(undefined));
        return {
          next: replaceAgent(state, {
            ...entry,
            installation: "Installed",
            updatedAt: installedAt,
          }),
          actions: [],
          result: Result.succeed(undefined),
        };
      }),
    );
  });

  const transitionStatus = (
    id: AgentId,
    allowed: ReadonlySet<AgentStatus>,
    status: AgentStatus,
    updatedAt: number,
  ): Effect.Effect<void, UnknownAgent> =>
    transact((state): Transition<void, UnknownAgent> => {
      return withAgent<void, never>(state, id, (entry) => {
        if (!allowed.has(entry.status)) {
          throw new RegistryInvariantDefect(
            `Invalid status transition ${entry.status} -> ${status} for ${id}`,
          );
        }
        return {
          next: replaceAgent(state, { ...entry, status, updatedAt }),
          actions: [],
          result: Result.succeed(undefined),
        };
      });
    });

  const QUEUED = new Set<AgentStatus>(["Queued"]);
  const QUEUED_OR_STARTING = new Set<AgentStatus>(["Queued", "Starting"]);
  const markStarting = Effect.fn("Brood.Registry.markStarting")(function* (id: AgentId) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* transitionStatus(id, QUEUED, "Starting", updatedAt);
  });
  const markRunning = Effect.fn("Brood.Registry.markRunning")(function* (id: AgentId) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* transitionStatus(id, QUEUED_OR_STARTING, "Running", updatedAt);
  });

  type TakeDecision = Data.TaggedEnum<{
    Command: { readonly command: AgentCommand };
    Interrupted: { readonly reason: InterruptReason };
    Empty: Record<never, never>;
  }>;
  const TakeDecision = Data.taggedEnum<TakeDecision>();

  const takePendingCommand = Effect.fn("Brood.Registry.takePendingCommand")(function* (
    id: AgentId,
  ) {
    while (true) {
      const before = yield* Ref.get(stateRef);
      const current = before.agents.get(id);
      if (current === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
      yield* Latch.close(current.mailbox);
      const takenAt = yield* Clock.currentTimeMillis;

      const decision = yield* transact((state): Transition<TakeDecision, UnknownAgent> => {
        return withAgent<TakeDecision, never>(state, id, (entry) => {
          if (entry.interruptRequested !== undefined) {
            return noChange(
              state,
              Result.succeed(TakeDecision.Interrupted({ reason: entry.interruptRequested })),
            );
          }
          if (entry.pendingCommand !== undefined) {
            const command = entry.pendingCommand;
            return {
              next: replaceAgent(state, {
                ...entry,
                pendingCommand: undefined,
                updatedAt: takenAt,
              }),
              actions: [],
              result: Result.succeed(TakeDecision.Command({ command })),
            };
          }
          if (entry.outcome !== undefined) {
            throw new RegistryInvariantDefect(`Terminal agent ${id} cannot take another command`);
          }
          return noChange(state, Result.succeed(TakeDecision.Empty()));
        });
      });

      const command = yield* TakeDecision.$match(decision, {
        Command: ({ command: pending }) => Effect.succeed(Option.some(pending)),
        Interrupted: ({ reason }) =>
          Effect.fail({
            _tag: "CommandInterrupted",
            agentId: id,
            reason,
          } satisfies CommandInterrupted),
        Empty: () => Latch.await(current.mailbox).pipe(Effect.as(Option.none<AgentCommand>())),
      });
      if (Option.isSome(command)) return command.value;
    }
  });

  const settleTransition = (
    state: RegistryState,
    id: AgentId,
    requestedOutcome: AgentOutcome,
    settledAt: number,
    onlyIfPendingInstallation: boolean,
  ): Transition<Option.Option<AgentOutcome>, UnknownAgent> =>
    withAgent<Option.Option<AgentOutcome>, never>(state, id, (entry) => {
      if (entry.outcome !== undefined) return noChange(state, Result.succeed(Option.none()));
      if (onlyIfPendingInstallation && entry.installation !== "Pending") {
        return noChange(state, Result.succeed(Option.none()));
      }

      const outcome: AgentOutcome =
        entry.interruptRequested === undefined
          ? requestedOutcome
          : { _tag: "Interrupted", reason: entry.interruptRequested };
      const settled: AgentEntry = {
        ...entry,
        status: outcome._tag,
        installation: "Installed",
        pendingCommand: undefined,
        plannedTargets: [],
        activeWait: undefined,
        outcome,
        updatedAt: settledAt,
        terminalAt: settledAt,
      };
      let next = replaceAgent(state, settled);
      const actions: Array<PostCommitAction> = [
        PostCommitAction.Complete({ deferred: entry.completion, outcome }),
        PostCommitAction.Open({ latch: entry.mailbox }),
      ];
      const parent = entry.parentId === undefined ? undefined : next.agents.get(entry.parentId);
      if (
        parent?.activeWait !== undefined &&
        parent.activeWait.targetIds.includes(id) &&
        parent.activeWait.targetIds.every(
          (targetId) => next.agents.get(targetId)?.outcome !== undefined,
        )
      ) {
        if (parent.pendingCommand !== undefined) {
          throw new RegistryInvariantDefect(`Satisfied wait for ${parent.id} found a full mailbox`);
        }
        if (parent.interruptRequested === undefined) {
          const command: AgentCommand = {
            _tag: "Resume",
            waitId: parent.activeWait.waitId,
            outcomes: outcomesFor(next, parent.activeWait.targetIds),
          };
          next = replaceAgent(next, {
            ...parent,
            status: "Queued",
            pendingCommand: command,
            activeWait: undefined,
            updatedAt: settledAt,
          });
          actions.push(PostCommitAction.Open({ latch: parent.mailbox }));
        }
      }
      const nonterminalCount = state.nonterminalCount - 1;
      const reachedQuiescence = nonterminalCount === 0;
      if (reachedQuiescence) actions.push(PostCommitAction.Open({ latch: quiescence }));
      return {
        next: {
          ...next,
          accepting: reachedQuiescence ? false : next.accepting,
          nonterminalCount,
        },
        actions,
        result: Result.succeed(Option.some(outcome)),
      };
    });

  const settle = Effect.fn("Brood.Registry.settle")(function* (id: AgentId, outcome: AgentOutcome) {
    const settledAt = yield* Clock.currentTimeMillis;
    return yield* transact((state) => settleTransition(state, id, outcome, settledAt, false));
  });

  const awaitOutcome = Effect.fn("Brood.Registry.awaitOutcome")(function* (id: AgentId) {
    const state = yield* Ref.get(stateRef);
    const entry = state.agents.get(id);
    if (entry === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
    return yield* Deferred.await(entry.completion);
  });

  const requestInterrupt = Effect.fn("Brood.Registry.requestInterrupt")(function* (
    id: AgentId,
    reason: InterruptReason,
  ) {
    const requestedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<boolean, UnknownAgent> =>
      withAgent<boolean, never>(state, id, (entry) => {
        if (entry.outcome !== undefined || entry.interruptRequested !== undefined) {
          return noChange(state, Result.succeed(false));
        }
        return {
          next: replaceAgent(state, {
            ...entry,
            interruptRequested: reason,
            updatedAt: requestedAt,
          }),
          actions: [PostCommitAction.Open({ latch: entry.mailbox })],
          result: Result.succeed(true),
        };
      }),
    );
  });

  const beginShutdown = Effect.fn("Brood.Registry.beginShutdown")(function* (
    reason: InterruptReason,
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<ShutdownResult, never> => {
      const agents = new Map(state.agents);
      const activeIds: Array<AgentId> = [];
      const newlyRequested: Array<CommittedInterruptRequest> = [];
      const actions: Array<PostCommitAction> = [];
      for (const entry of state.agents.values()) {
        if (entry.outcome !== undefined) continue;
        activeIds.push(entry.id);
        if (entry.interruptRequested === undefined) {
          agents.set(entry.id, { ...entry, interruptRequested: reason, updatedAt });
          newlyRequested.push({ agentId: entry.id, reason });
          actions.push(PostCommitAction.Open({ latch: entry.mailbox }));
        }
      }
      if (state.nonterminalCount === 0) {
        actions.push(PostCommitAction.Open({ latch: quiescence }));
      }
      return {
        next: { ...state, agents, accepting: false },
        actions,
        result: Result.succeed({ activeIds, newlyRequested }),
      };
    });
  });

  const settlePendingInstallations = Effect.fn("Brood.Registry.settlePendingInstallations")(
    function* (reason: InterruptReason) {
      const state = yield* Ref.get(stateRef);
      if (state.accepting) {
        return yield* Effect.die(
          new RegistryInvariantDefect("Pending installations can settle only after shutdown"),
        );
      }
      const pending = Array.from(state.agents.values())
        .filter((entry) => entry.installation === "Pending" && entry.outcome === undefined)
        .map((entry) => entry.id);
      const results = yield* Effect.forEach(pending, (id) =>
        Effect.gen(function* () {
          const settledAt = yield* Clock.currentTimeMillis;
          return yield* transact((current) =>
            settleTransition(current, id, { _tag: "Interrupted", reason }, settledAt, true),
          ).pipe(
            Effect.orDie,
            Effect.map((outcome) => ({ id, outcome })),
          );
        }),
      );
      return results.flatMap(({ id, outcome }) =>
        Option.isSome(outcome) ? [{ agentId: id, outcome: outcome.value }] : [],
      );
    },
  );

  const awaitQuiescence = Effect.fn("Brood.Registry.awaitQuiescence")(function* () {
    while (true) {
      yield* Latch.close(quiescence);
      const state = yield* Ref.get(stateRef);
      if (state.nonterminalCount === 0 && (state.rootId !== undefined || !state.accepting)) return;
      yield* Latch.await(quiescence);
    }
  })();

  const snapshot = Ref.get(stateRef).pipe(
    Effect.map((state): RegistrySnapshot => {
      const agents = Array.from(state.agents.values(), (entry): AgentSnapshot => ({
        id: entry.id,
        name: entry.name,
        parentId: entry.parentId,
        profile: entry.profile,
        status: entry.status,
        installation: entry.installation,
        waitTargets: waitTargets(entry),
        hasPendingCommand: entry.pendingCommand !== undefined,
        interruptRequested: entry.interruptRequested,
        outcome: entry.outcome,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        terminalAt: entry.terminalAt,
      }));
      return {
        agents,
        rootId: state.rootId,
        accepting: state.accepting,
        nonterminalCount: state.nonterminalCount,
        pendingInstallationCount: agents.filter(({ installation }) => installation === "Pending")
          .length,
      };
    }),
  );

  return {
    registerRoot,
    registerBatch,
    settle,
    planWait,
    activateWaits,
    markInstalled,
    markStarting,
    markRunning,
    takePendingCommand,
    awaitOutcome,
    requestInterrupt,
    beginShutdown,
    settlePendingInstallations,
    awaitQuiescence,
    snapshot,
  } satisfies AgentRegistry;
});
