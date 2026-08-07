import { Deferred, Effect, Latch, Ref } from "effect";
import type { Deferred as DeferredType } from "effect/Deferred";
import type { Latch as LatchType } from "effect/Latch";
/* oxlint-disable no-underscore-dangle -- Effect domain variants intentionally use `_tag`. */
import {
  DelegateRejected,
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

export interface RegisterRootInput {
  readonly name: AgentName;
  readonly goal: string;
  readonly profile: PublicModelProfile;
}

export interface RegisterChildInput {
  readonly name: AgentName;
  readonly goal: string;
  readonly profile: PublicModelProfile;
}

export interface RegisterBatchInput {
  readonly parentId: AgentId;
  readonly invocationId: ToolInvocationId;
  readonly children: ReadonlyArray<RegisterChildInput>;
  readonly wait: "all" | "none";
}

export interface BatchRegistration {
  readonly children: ReadonlyArray<RegisteredAgent>;
  readonly waitPlanned: boolean;
}

export interface PlanWaitInput {
  readonly parentId: AgentId;
  readonly invocationId: ToolInvocationId;
  readonly childNames: ReadonlyArray<AgentName>;
}

export type WaitPlanResult =
  | {
      readonly _tag: "Ready";
      readonly targetIds: ReadonlyArray<AgentId>;
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

export class RegistryInvariantDefect extends Error {
  readonly _tag = "RegistryInvariantDefect";
}

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

interface PlannedWait {
  readonly invocationId: ToolInvocationId;
  readonly targetIds: ReadonlyArray<AgentId>;
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
  readonly plannedWaits: ReadonlyMap<ToolInvocationId, PlannedWait>;
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
  readonly pendingInstallationCount: number;
}

type PostCommitAction =
  | {
      readonly _tag: "Complete";
      readonly deferred: DeferredType<AgentOutcome>;
      readonly outcome: AgentOutcome;
    }
  | { readonly _tag: "Open"; readonly latch: LatchType };

interface TransitionSuccess<A> {
  readonly _tag: "Success";
  readonly value: A;
}

interface TransitionFailure<E> {
  readonly _tag: "Failure";
  readonly error: E;
}

type TransitionResult<A, E> = TransitionSuccess<A> | TransitionFailure<E>;

interface Transition<A, E> {
  readonly next: RegistryState;
  readonly actions: ReadonlyArray<PostCommitAction>;
  readonly result: TransitionResult<A, E>;
}

const success = <A>(value: A): TransitionSuccess<A> => ({ _tag: "Success", value });
const failure = <E>(error: E): TransitionFailure<E> => ({ _tag: "Failure", error });

const noChange = <A, E>(
  state: RegistryState,
  result: TransitionResult<A, E>,
): Transition<A, E> => ({
  next: state,
  actions: [],
  result,
});

const isTerminal = (status: AgentStatus): boolean =>
  status === "Completed" || status === "Failed" || status === "Interrupted";

const terminalStatus = (outcome: AgentOutcome): AgentStatus => {
  switch (outcome._tag) {
    case "Completed":
      return "Completed";
    case "Failed":
      return "Failed";
    case "Interrupted":
      return "Interrupted";
  }
};

const copyProfile = (profile: PublicModelProfile): PublicModelProfile =>
  Object.freeze({
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
  });

const replaceAgent = (state: RegistryState, entry: AgentEntry): RegistryState => {
  const agents = new Map(state.agents);
  agents.set(entry.id, entry);
  return { ...state, agents };
};

const waitTargets = (entry: AgentEntry): ReadonlyArray<AgentId> => {
  if (entry.activeWait !== undefined) return [...entry.activeWait.targetIds];
  const targetIds: Array<AgentId> = [];
  const selected = new Set<AgentId>();
  for (const plan of entry.plannedWaits.values()) {
    for (const targetId of plan.targetIds) {
      if (!selected.has(targetId)) {
        selected.add(targetId);
        targetIds.push(targetId);
      }
    }
  }
  return targetIds;
};

const dispatchAction = (action: PostCommitAction): Effect.Effect<void> => {
  switch (action._tag) {
    case "Complete":
      return Deferred.succeed(action.deferred, action.outcome).pipe(Effect.asVoid);
    case "Open":
      return Latch.open(action.latch).pipe(Effect.asVoid);
  }
};

const finishTransition = <A, E>(result: TransitionResult<A, E>): Effect.Effect<A, E> =>
  result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error);

export interface RegistryOptions {
  readonly maxAgents: number;
  readonly maxFailureMessageChars?: number;
  readonly nextAgentId?: () => AgentId;
  readonly nextWaitId?: () => WaitId;
  readonly now?: () => number;
}

export interface AgentRegistry {
  readonly registerRoot: (
    input: RegisterRootInput,
  ) => Effect.Effect<RegisteredAgent, RootStartError>;
  readonly registerBatch: (
    input: RegisterBatchInput,
  ) => Effect.Effect<BatchRegistration, DelegateRejected | UnknownAgent>;
  readonly settle: (id: AgentId, outcome: AgentOutcome) => Effect.Effect<boolean, UnknownAgent>;
  readonly planWait: (
    input: PlanWaitInput,
  ) => Effect.Effect<WaitPlanResult, WaitRejected | UnknownAgent>;
  readonly activateWaits: (id: AgentId) => Effect.Effect<WaitActivation, UnknownAgent>;
  readonly markInstalled: (id: AgentId) => Effect.Effect<boolean, UnknownAgent>;
  readonly markStarting: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly markRunning: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly takePendingCommand: (
    id: AgentId,
  ) => Effect.Effect<AgentCommand, UnknownAgent | CommandInterrupted>;
  readonly signalMailbox: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly awaitOutcome: (id: AgentId) => Effect.Effect<AgentOutcome, UnknownAgent>;
  readonly requestInterrupt: (
    id: AgentId,
    reason: InterruptReason,
  ) => Effect.Effect<boolean, UnknownAgent>;
  readonly beginShutdown: (reason: InterruptReason) => Effect.Effect<ShutdownResult>;
  readonly settlePendingInstallations: (
    reason: InterruptReason,
  ) => Effect.Effect<ReadonlyArray<AgentId>>;
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
  profile: copyProfile(registration.profile),
  status: "Queued",
  installation: "Pending",
  pendingCommand: { _tag: "InitialGoal", goal },
  mailbox,
  completion,
  outcome: undefined,
  interruptRequested: undefined,
  seenInvocations: new Set(),
  plannedWaits: new Map(),
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

  const now = options.now ?? Date.now;
  const maxFailureMessageChars = options.maxFailureMessageChars ?? 2_000;
  const nextAgentId = options.nextAgentId ?? (() => makeAgentId(`agent_${crypto.randomUUID()}`));
  const nextWaitId = options.nextWaitId ?? (() => makeWaitId(`wait_${crypto.randomUUID()}`));
  const quiescence = yield* Latch.make(false);
  const stateRef = yield* Ref.make<RegistryState>({
    agents: new Map(),
    rootId: undefined,
    accepting: true,
    nonterminalCount: 0,
    pendingInstallationCount: 0,
  });

  const transact = <A, E>(
    transition: (state: RegistryState) => Transition<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.uninterruptibleMask(() =>
      Ref.modify(stateRef, (state) => {
        const committed = transition(state);
        return [committed, committed.next];
      }).pipe(
        Effect.flatMap((committed) =>
          Effect.forEach(committed.actions, dispatchAction, { discard: true }).pipe(
            Effect.andThen(finishTransition(committed.result)),
          ),
        ),
      ),
    );

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
    const registered: RegisteredAgent = {
      id,
      name: input.name,
      parentId: undefined,
      profile: copyProfile(input.profile),
    };
    const entry = makeEntry(registered, input.goal, now(), mailbox, completion);

    return yield* transact((state): Transition<RegisteredAgent, RootStartError> => {
      if (!state.accepting || state.rootId !== undefined) {
        return noChange(
          state,
          failure(
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
          pendingInstallationCount: 1,
        },
        actions: [{ _tag: "Open", latch: mailbox }],
        result: success(registered),
      };
    });
  });

  const registerBatch = Effect.fn("Brood.Registry.registerBatch")(function* (
    input: RegisterBatchInput,
  ) {
    const registeredAt = now();
    const prepared = yield* Effect.forEach(input.children, (child) =>
      Effect.gen(function* () {
        const registered: RegisteredAgent = {
          id: nextAgentId(),
          name: child.name,
          parentId: input.parentId,
          profile: copyProfile(child.profile),
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
        const parent = state.agents.get(input.parentId);
        if (parent === undefined) {
          return noChange(state, failure(new UnknownAgent({ agentId: input.parentId })));
        }
        if (!state.accepting) {
          return noChange(
            state,
            failure(
              new DelegateRejected({
                reason: "NotAccepting",
                message: "The registry is shutting down",
              }),
            ),
          );
        }
        if (isTerminal(parent.status)) {
          return noChange(
            state,
            failure(
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
            failure(
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
            failure(
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
            failure(
              new DelegateRejected({
                reason: "AgentLimitExceeded",
                message: `Agent limit ${maxAgents} would be exceeded by ${input.children.length} requested children`,
              }),
            ),
          );
        }

        const names = new Set<AgentName>();
        const ids = new Set<AgentId>();
        for (const child of input.children) {
          if (names.has(child.name) || parent.childrenByName.has(child.name)) {
            return noChange(
              state,
              failure(
                new DelegateRejected({
                  reason: "NameCollision",
                  message: `Direct-child name ${child.name} has already been used`,
                }),
              ),
            );
          }
          names.add(child.name);
        }
        for (const child of prepared) {
          if (ids.has(child.registered.id) || state.agents.has(child.registered.id)) {
            throw new RegistryInvariantDefect(`Agent ID generator reused ${child.registered.id}`);
          }
          ids.add(child.registered.id);
        }

        const agents = new Map(state.agents);
        const childrenByName = new Map(parent.childrenByName);
        for (const child of prepared) {
          agents.set(child.registered.id, child.entry);
          childrenByName.set(child.registered.name, child.registered.id);
        }
        const seenInvocations = new Set(parent.seenInvocations);
        seenInvocations.add(input.invocationId);
        const plannedWaits = new Map(parent.plannedWaits);
        if (input.wait === "all") {
          const targetIds = Object.freeze(prepared.map(({ registered }) => registered.id));
          plannedWaits.set(input.invocationId, {
            invocationId: input.invocationId,
            targetIds,
          });
        }
        agents.set(parent.id, {
          ...parent,
          childrenByName,
          seenInvocations,
          plannedWaits,
          updatedAt: registeredAt,
        });

        return {
          next: {
            ...state,
            agents,
            nonterminalCount: state.nonterminalCount + prepared.length,
            pendingInstallationCount: state.pendingInstallationCount + prepared.length,
          },
          actions: prepared.map(({ entry }) => ({ _tag: "Open", latch: entry.mailbox })),
          result: success({
            children: prepared.map(({ registered }) => registered),
            waitPlanned: input.wait === "all",
          }),
        };
      },
    );
  });

  const planWait = Effect.fn("Brood.Registry.planWait")((input: PlanWaitInput) => {
    const plannedAt = now();
    return transact((state): Transition<WaitPlanResult, WaitRejected | UnknownAgent> => {
      const parent = state.agents.get(input.parentId);
      if (parent === undefined) {
        return noChange(state, failure(new UnknownAgent({ agentId: input.parentId })));
      }
      if (parent.seenInvocations.has(input.invocationId)) {
        return noChange(
          state,
          failure(
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
          failure(
            new WaitRejected({
              reason: "EmptySelection",
              message: "A wait requires at least one child",
            }),
          ),
        );
      }
      if (isTerminal(parent.status)) {
        return noChange(
          state,
          failure(
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
            failure(
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
      const canonicalTargetIds = Object.freeze([...targetIds]);
      const allTerminal = canonicalTargetIds.every((targetId) => {
        const target = state.agents.get(targetId);
        return target !== undefined && target.outcome !== undefined;
      });
      const plannedWaits = new Map(parent.plannedWaits);
      if (!allTerminal) {
        plannedWaits.set(input.invocationId, {
          invocationId: input.invocationId,
          targetIds: canonicalTargetIds,
        });
      }
      const next = replaceAgent(state, {
        ...parent,
        seenInvocations,
        plannedWaits,
        updatedAt: plannedAt,
      });

      return {
        next,
        actions: [],
        result: success(
          allTerminal
            ? {
                _tag: "Ready",
                targetIds: canonicalTargetIds,
                outcomes: outcomesFor(state, canonicalTargetIds),
              }
            : { _tag: "Planned", targetIds: canonicalTargetIds },
        ),
      };
    });
  });

  const activateWaits = Effect.fn("Brood.Registry.activateWaits")((id: AgentId) => {
    const waitId = nextWaitId();
    const activatedAt = now();
    return transact((state): Transition<WaitActivation, UnknownAgent> => {
      const parent = state.agents.get(id);
      if (parent === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
      if (parent.status !== "Running") {
        throw new RegistryInvariantDefect(`Cannot activate waits for ${id} while ${parent.status}`);
      }
      if (parent.plannedWaits.size === 0) {
        throw new RegistryInvariantDefect(`Suspended agent ${id} has no planned waits`);
      }
      if (parent.pendingCommand !== undefined || parent.activeWait !== undefined) {
        throw new RegistryInvariantDefect(`Agent ${id} already has active mailbox or wait state`);
      }

      const targetIds: Array<AgentId> = [];
      const selected = new Set<AgentId>();
      for (const plan of parent.plannedWaits.values()) {
        for (const targetId of plan.targetIds) {
          if (!selected.has(targetId)) {
            selected.add(targetId);
            targetIds.push(targetId);
          }
        }
      }
      if (targetIds.length === 0) {
        throw new RegistryInvariantDefect(`Suspended agent ${id} planned an empty wait`);
      }
      const canonicalTargetIds = Object.freeze([...targetIds]);

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
          plannedWaits: new Map(),
          activeWait: undefined,
          updatedAt: activatedAt,
        });
        return {
          next,
          actions: [{ _tag: "Open", latch: parent.mailbox }],
          result: success({ _tag: "Resumed", waitId, targetIds: canonicalTargetIds }),
        };
      }

      const activeWait: ActiveWait = { waitId, targetIds: canonicalTargetIds };
      const next = replaceAgent(state, {
        ...parent,
        status: "Waiting",
        plannedWaits: new Map(),
        activeWait,
        updatedAt: activatedAt,
      });
      return {
        next,
        actions: [],
        result: success({ _tag: "Waiting", waitId, targetIds: canonicalTargetIds }),
      };
    });
  });

  const markInstalled = Effect.fn("Brood.Registry.markInstalled")((id: AgentId) => {
    const installedAt = now();
    return transact((state): Transition<boolean, UnknownAgent> => {
      const entry = state.agents.get(id);
      if (entry === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
      if (entry.installation === "Installed") return noChange(state, success(false));
      const next = replaceAgent(state, {
        ...entry,
        installation: "Installed",
        updatedAt: installedAt,
      });
      return {
        next: { ...next, pendingInstallationCount: state.pendingInstallationCount - 1 },
        actions: [],
        result: success(true),
      };
    });
  });

  const transitionStatus = (
    id: AgentId,
    allowed: ReadonlySet<AgentStatus>,
    status: AgentStatus,
    updatedAt: number,
  ): Effect.Effect<void, UnknownAgent> =>
    transact((state): Transition<void, UnknownAgent> => {
      const entry = state.agents.get(id);
      if (entry === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
      if (!allowed.has(entry.status)) {
        throw new RegistryInvariantDefect(
          `Invalid status transition ${entry.status} -> ${status} for ${id}`,
        );
      }
      return {
        next: replaceAgent(state, { ...entry, status, updatedAt }),
        actions: [],
        result: success(undefined),
      };
    });

  const markStarting = Effect.fn("Brood.Registry.markStarting")((id: AgentId) =>
    transitionStatus(id, new Set(["Queued"]), "Starting", now()),
  );
  const markRunning = Effect.fn("Brood.Registry.markRunning")((id: AgentId) =>
    transitionStatus(id, new Set(["Queued", "Starting"]), "Running", now()),
  );

  const signalMailbox = Effect.fn("Brood.Registry.signalMailbox")(function* (id: AgentId) {
    const state = yield* Ref.get(stateRef);
    const entry = state.agents.get(id);
    if (entry === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
    yield* Latch.open(entry.mailbox);
  });

  type TakeDecision =
    | { readonly _tag: "Command"; readonly command: AgentCommand }
    | { readonly _tag: "Interrupted"; readonly reason: InterruptReason }
    | { readonly _tag: "Empty"; readonly mailbox: LatchType };

  const takeLoop = (id: AgentId): Effect.Effect<AgentCommand, UnknownAgent | CommandInterrupted> =>
    Effect.gen(function* () {
      const before = yield* Ref.get(stateRef);
      const current = before.agents.get(id);
      if (current === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
      yield* Latch.close(current.mailbox);
      const takenAt = now();

      const decision = yield* transact((state): Transition<TakeDecision, UnknownAgent> => {
        const entry = state.agents.get(id);
        if (entry === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
        if (entry.interruptRequested !== undefined) {
          return noChange(
            state,
            success({ _tag: "Interrupted", reason: entry.interruptRequested }),
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
            result: success({ _tag: "Command", command }),
          };
        }
        if (isTerminal(entry.status)) {
          throw new RegistryInvariantDefect(`Terminal agent ${id} cannot take another command`);
        }
        return noChange(state, success({ _tag: "Empty", mailbox: entry.mailbox }));
      });

      switch (decision._tag) {
        case "Command":
          return decision.command;
        case "Interrupted": {
          const interrupted: CommandInterrupted = {
            _tag: "CommandInterrupted",
            agentId: id,
            reason: decision.reason,
          };
          return yield* Effect.fail(interrupted);
        }
        case "Empty":
          yield* Latch.await(decision.mailbox);
          return yield* Effect.suspend(() => takeLoop(id));
      }
    });

  const takePendingCommand = Effect.fn("Brood.Registry.takePendingCommand")(takeLoop);

  const settleTransition = (
    state: RegistryState,
    id: AgentId,
    requestedOutcome: AgentOutcome,
    settledAt: number,
    onlyIfPendingInstallation: boolean,
  ): Transition<boolean, UnknownAgent> => {
    const entry = state.agents.get(id);
    if (entry === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
    if (isTerminal(entry.status)) return noChange(state, success(false));
    if (onlyIfPendingInstallation && entry.installation !== "Pending") {
      return noChange(state, success(false));
    }

    const outcome: AgentOutcome =
      entry.interruptRequested === undefined
        ? requestedOutcome
        : { _tag: "Interrupted", reason: entry.interruptRequested };
    const settled: AgentEntry = {
      ...entry,
      status: terminalStatus(outcome),
      installation: "Installed",
      pendingCommand: undefined,
      plannedWaits: new Map(),
      activeWait: undefined,
      outcome,
      updatedAt: settledAt,
      terminalAt: settledAt,
    };
    let next = replaceAgent(state, settled);
    const actions: Array<PostCommitAction> = [
      { _tag: "Complete", deferred: entry.completion, outcome },
      { _tag: "Open", latch: entry.mailbox },
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
        actions.push({ _tag: "Open", latch: parent.mailbox });
      }
    }
    const nonterminalCount = state.nonterminalCount - 1;
    const reachedQuiescence = nonterminalCount === 0 && state.rootId !== undefined;
    if (reachedQuiescence) actions.push({ _tag: "Open", latch: quiescence });
    return {
      next: {
        ...next,
        accepting: reachedQuiescence ? false : next.accepting,
        nonterminalCount,
        pendingInstallationCount:
          entry.installation === "Pending"
            ? state.pendingInstallationCount - 1
            : state.pendingInstallationCount,
      },
      actions,
      result: success(true),
    };
  };

  const settle = Effect.fn("Brood.Registry.settle")((id: AgentId, outcome: AgentOutcome) => {
    const settledAt = now();
    return transact((state) => settleTransition(state, id, outcome, settledAt, false));
  });

  const awaitOutcome = Effect.fn("Brood.Registry.awaitOutcome")(function* (id: AgentId) {
    const state = yield* Ref.get(stateRef);
    const entry = state.agents.get(id);
    if (entry === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
    return yield* Deferred.await(entry.completion);
  });

  const requestInterrupt = Effect.fn("Brood.Registry.requestInterrupt")((
    id: AgentId,
    reason: InterruptReason,
  ) => {
    const requestedAt = now();
    return transact((state): Transition<boolean, UnknownAgent> => {
      const entry = state.agents.get(id);
      if (entry === undefined) return noChange(state, failure(new UnknownAgent({ agentId: id })));
      if (isTerminal(entry.status) || entry.interruptRequested !== undefined) {
        return noChange(state, success(false));
      }
      return {
        next: replaceAgent(state, {
          ...entry,
          interruptRequested: reason,
          updatedAt: requestedAt,
        }),
        actions: [{ _tag: "Open", latch: entry.mailbox }],
        result: success(true),
      };
    });
  });

  const beginShutdown = Effect.fn("Brood.Registry.beginShutdown")((reason: InterruptReason) => {
    const updatedAt = now();
    return transact((state): Transition<ShutdownResult, never> => {
      const agents = new Map(state.agents);
      const activeIds: Array<AgentId> = [];
      const newlyRequested: Array<CommittedInterruptRequest> = [];
      const actions: Array<PostCommitAction> = [];
      for (const entry of state.agents.values()) {
        if (isTerminal(entry.status)) continue;
        activeIds.push(entry.id);
        if (entry.interruptRequested === undefined) {
          agents.set(entry.id, { ...entry, interruptRequested: reason, updatedAt });
          newlyRequested.push({ agentId: entry.id, reason });
          actions.push({ _tag: "Open", latch: entry.mailbox });
        }
      }
      if (state.nonterminalCount === 0) actions.push({ _tag: "Open", latch: quiescence });
      return {
        next: { ...state, agents, accepting: false },
        actions,
        result: success({ activeIds, newlyRequested }),
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
        .filter((entry) => entry.installation === "Pending" && !isTerminal(entry.status))
        .map((entry) => entry.id);
      const results = yield* Effect.forEach(pending, (id) => {
        const settledAt = now();
        return transact((current) =>
          settleTransition(current, id, { _tag: "Interrupted", reason }, settledAt, true),
        ).pipe(
          Effect.orDie,
          Effect.map((settled) => ({ id, settled })),
        );
      });
      return results.filter(({ settled }) => settled).map(({ id }) => id);
    },
  );

  const awaitQuiescenceLoop = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Latch.close(quiescence);
      const state = yield* Ref.get(stateRef);
      if (state.nonterminalCount === 0 && (state.rootId !== undefined || !state.accepting)) return;
      yield* Latch.await(quiescence);
      return yield* Effect.suspend(awaitQuiescenceLoop);
    });

  const awaitQuiescence = Effect.fn("Brood.Registry.awaitQuiescence")(awaitQuiescenceLoop)();

  const snapshot = Ref.get(stateRef).pipe(
    Effect.map((state): RegistrySnapshot => ({
      agents: Array.from(state.agents.values(), (entry): AgentSnapshot => ({
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
      })),
      rootId: state.rootId,
      accepting: state.accepting,
      nonterminalCount: state.nonterminalCount,
      pendingInstallationCount: state.pendingInstallationCount,
    })),
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
    signalMailbox,
    awaitOutcome,
    requestInterrupt,
    beginShutdown,
    settlePendingInstallations,
    awaitQuiescence,
    snapshot,
  } satisfies AgentRegistry;
});
