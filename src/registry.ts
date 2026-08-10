/**
 * Serialized agent registry: one Ref of immutable state, mutated only through
 * pure transitions that return idempotent post-commit actions (complete a
 * deferred, open a latch). Every agent lifecycle fact — admission, waits, the
 * single-slot command mailbox, terminal settlement, shutdown — commits here
 * or nowhere. No transition may wait on Pi, the semaphore, or I/O.
 */
import { Clock, Data, Deferred, Effect, Latch, Option, Ref, Result, Schema } from "effect";
import type { Deferred as DeferredType } from "effect/Deferred";
import type { Latch as LatchType } from "effect/Latch";
/* oxlint-disable no-underscore-dangle -- Effect domain variants intentionally use `_tag`. */
import {
  AgentAdmissionLimitExceeded,
  DelegateRejected,
  PiProtocolError,
  RootStartError,
  type DelegateError,
  UnknownAgent,
  WaitRejected,
  makeAgentId,
  makeWaitId,
  type AgentAdmissionCapacity,
  type AgentId,
  type AgentName,
  type AgentOutcome,
  type AgentResult,
  type AgentStatus,
  type DependencyOutcome,
  type InterruptReason,
  type ToolInvocationId,
  type WaitId,
} from "./agent.js";
import { type AgentCommand, type PiRunOutcome } from "./control.js";
import type { PublicModelProfile } from "./profiles.js";
import { DEFAULT_MAX_FAILURE_MESSAGE_CHARS, dependencyOutcomeFromAgent } from "./render.js";
import {
  AskAgentRejected,
  MAX_DIRECTORY_PAGE_ITEMS,
  MAX_BULLETIN_READ_ITEMS,
  MAX_BULLETINS_PER_AUTHOR,
  MAX_INBOX_READ_ITEMS,
  MAX_INCOMING_REQUESTS_PER_AGENT,
  MAX_REQUEST_TARGETS_PER_WAIT,
  MAX_TOOL_RESULT_CHARS,
  MAX_UNREAD_MESSAGES_PER_AGENT,
  PostBulletinRejected,
  ReadBulletinsRejected,
  ReadMessagesRejected,
  ReplyRejected,
  SendMessageRejected,
  SetActivityRejected,
  decodeAgentPath,
  makeAgentPath,
  makeRequestId,
  type AgentActivity,
  type AgentDirectoryEntry,
  type AgentPath,
  type AskAgentInput,
  type AskAgentToolDetails,
  type BulletinPost,
  type ListAgentsInput,
  type ListAgentsRejected,
  type ListAgentsResult,
  type PostBulletinInput,
  type PostBulletinResult,
  type ReadBulletinsInput,
  type ReadBulletinsResult,
  type ReadMessagesInput,
  type ReadMessagesResult,
  type PeerRequestOutcome,
  type ReplyToRequestInput,
  type ReplyToRequestResult,
  type RequestId,
  type SendMessageInput,
  type SendMessageResult,
  type SetActivityInput,
  type SetActivityResult,
} from "./communication.js";

export type InstallationStatus = "Pending" | "Installed";

export interface RegisteredAgent {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly path: AgentPath;
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
  /** Capacity produced by this batch's own transition, not a later query. */
  readonly capacityAfterCommit: AgentAdmissionCapacity;
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
  readonly activity: AgentActivity | undefined;
}

export interface RegistrySnapshot {
  readonly agents: ReadonlyArray<AgentSnapshot>;
  readonly rootId: AgentId | undefined;
  readonly accepting: boolean;
  readonly nonterminalCount: number;
  readonly pendingInstallationCount: number;
  readonly admissionCapacity: AgentAdmissionCapacity;
  readonly retainedBulletinCount: number;
}

interface WaitTargets {
  readonly dependencies: ReadonlyArray<AgentId>;
  readonly requests: ReadonlyArray<RequestId>;
}

interface PlannedWait extends WaitTargets {
  readonly tool: "delegate" | "wait_for_agents" | "ask_agent";
}

interface ActiveWait extends WaitTargets {
  readonly waitId: WaitId;
}

const CommandToken = Schema.String.pipe(Schema.brand("CommandToken"));
export type CommandToken = typeof CommandToken.Type;
const makeCommandToken = Schema.decodeUnknownSync(CommandToken);

type CommandTrigger = "initial" | "wait-satisfied" | "coordination";

interface ClaimedCommand {
  readonly token: CommandToken;
  readonly trigger: CommandTrigger;
}

interface RunningCommand {
  readonly token: CommandToken;
}

type InboxEntry =
  | {
      readonly _tag: "Message";
      readonly sequence: number;
      readonly fromId: AgentId;
      readonly body: string;
    }
  | {
      readonly _tag: "Request";
      readonly sequence: number;
      readonly requestId: RequestId;
      readonly presented: boolean;
    };

type RequestState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Replied"; readonly reply: string }
  | {
      readonly _tag: "Unavailable";
      readonly recipientState: "completed" | "failed" | "interrupted";
    };

interface RequestRecord {
  readonly id: RequestId;
  readonly requesterId: AgentId;
  readonly recipientId: AgentId;
  readonly wakeGeneration: number;
  readonly question: string;
  readonly state: RequestState;
}

interface BulletinRecord {
  readonly sequence: number;
  readonly authorId: AgentId;
  readonly authorPath: AgentPath;
  readonly body: string;
}

interface AgentEntry extends RegisteredAgent {
  readonly status: AgentStatus;
  readonly installation: InstallationStatus;
  readonly initialGoal: string | undefined;
  readonly claimedCommand: ClaimedCommand | undefined;
  readonly runningCommand: RunningCommand | undefined;
  readonly pendingCompletedResult: AgentResult | undefined;
  readonly mailbox: LatchType;
  readonly completion: DeferredType<AgentOutcome>;
  readonly outcome: AgentOutcome | undefined;
  readonly interruptRequested: InterruptReason | undefined;
  readonly turnInvocations: ReadonlyMap<ToolInvocationId, ToolOperationName>;
  readonly activity: AgentActivity | undefined;
  readonly inbox: ReadonlyArray<InboxEntry>;
  readonly nextInboxSequence: number;
  readonly bulletinCursor: number;
  readonly requestWakeGeneration: number;
  readonly claimedRequestWakeGeneration: number;
  readonly plannedWaits: ReadonlyMap<ToolInvocationId, PlannedWait>;
  readonly activeWait: ActiveWait | undefined;
  readonly childrenByName: ReadonlyMap<AgentName, AgentId>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | undefined;
}

interface RegistryState {
  readonly agents: ReadonlyMap<AgentId, AgentEntry>;
  readonly agentsByPath: ReadonlyMap<AgentPath, AgentId>;
  readonly requests: ReadonlyMap<RequestId, RequestRecord>;
  readonly bulletins: ReadonlyArray<BulletinRecord>;
  readonly nextBulletinSequence: number;
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

const plannedDependencies = (entry: AgentEntry): ReadonlyArray<AgentId> =>
  Array.from(entry.plannedWaits.values()).flatMap(({ dependencies }) => dependencies);

const plannedRequests = (entry: AgentEntry): ReadonlyArray<RequestId> =>
  Array.from(entry.plannedWaits.values()).flatMap(({ requests }) => requests);

const withTargets = <A>(
  current: ReadonlyArray<A>,
  additions: ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const selected = new Set(current);
  const targetIds: Array<A> = [...current];
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
  readonly maxAgentAdmissions: number;
  readonly maxFailureMessageChars?: number;
  readonly nextAgentId?: () => AgentId;
  readonly nextWaitId?: () => WaitId;
  readonly nextRequestId?: () => RequestId;
  readonly nextCommandToken?: () => string;
}

type ToolOperationName =
  | "delegate"
  | "wait_for_agents"
  | "set_activity"
  | "send_message"
  | "ask_agent"
  | "read_messages"
  | "reply_to_request"
  | "post_bulletin"
  | "read_bulletins";

export interface CommandClaim {
  readonly token: CommandToken;
  readonly trigger: CommandTrigger;
}

export type BeginRunResult =
  | { readonly _tag: "Ready"; readonly command: AgentCommand }
  | { readonly _tag: "Stale"; readonly status: "Waiting" }
  | { readonly _tag: "Settled"; readonly outcome: AgentOutcome };

export type FinishTurnInput =
  | {
      readonly agentId: AgentId;
      readonly commandToken: CommandToken;
      readonly piOutcome: Extract<PiRunOutcome, { readonly _tag: "Completed" }>;
      readonly completedResult: AgentResult;
    }
  | {
      readonly agentId: AgentId;
      readonly commandToken: CommandToken;
      readonly piOutcome: Extract<PiRunOutcome, { readonly _tag: "Suspended" }>;
    };

export type FinishTurnDecision = Data.TaggedEnum<{
  Settled: { readonly outcome: AgentOutcome };
  RunNext: Record<never, never>;
  Park: { readonly waitId: WaitId; readonly targetIds: ReadonlyArray<AgentId> };
}>;

export const FinishTurnDecision = Data.taggedEnum<FinishTurnDecision>();

export interface AgentRegistry {
  readonly registerRoot: (
    input: RegisterRootInput,
  ) => Effect.Effect<RegisteredAgent, RootStartError>;
  readonly registerBatch: (
    input: RegisterBatchInput,
  ) => Effect.Effect<BatchRegistration, DelegateError | UnknownAgent>;
  /** Authoritative snapshot, not a reservation: `used` is monotonic, so a
   * stale read can only overstate what remains. */
  readonly admissionCapacity: Effect.Effect<AgentAdmissionCapacity>;
  readonly listAgents: (
    callerId: AgentId,
    input: ListAgentsInput,
  ) => Effect.Effect<ListAgentsResult, ListAgentsRejected>;
  readonly setActivity: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SetActivityInput,
  ) => Effect.Effect<SetActivityResult, SetActivityRejected>;
  readonly sendMessage: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SendMessageInput,
  ) => Effect.Effect<SendMessageResult, SendMessageRejected>;
  readonly askAgent: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: AskAgentInput,
  ) => Effect.Effect<AskAgentToolDetails, AskAgentRejected>;
  readonly readMessages: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadMessagesInput,
  ) => Effect.Effect<ReadMessagesResult, ReadMessagesRejected>;
  readonly replyToRequest: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReplyToRequestInput,
  ) => Effect.Effect<ReplyToRequestResult, ReplyRejected>;
  readonly postBulletin: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: PostBulletinInput,
  ) => Effect.Effect<PostBulletinResult, PostBulletinRejected>;
  readonly readBulletins: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadBulletinsInput,
  ) => Effect.Effect<ReadBulletinsResult, ReadBulletinsRejected>;
  readonly settle: (
    id: AgentId,
    outcome: AgentOutcome,
  ) => Effect.Effect<Option.Option<AgentOutcome>, UnknownAgent>;
  readonly planWait: (
    input: PlanWaitInput,
  ) => Effect.Effect<WaitPlanResult, WaitRejected | UnknownAgent>;
  readonly markInstalled: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly markStarting: (id: AgentId) => Effect.Effect<void, UnknownAgent>;
  readonly takePendingCommand: (
    id: AgentId,
  ) => Effect.Effect<CommandClaim, UnknownAgent | CommandInterrupted>;
  readonly beginRun: (
    id: AgentId,
    token: CommandToken,
  ) => Effect.Effect<BeginRunResult, UnknownAgent | CommandInterrupted>;
  readonly finishTurn: (
    input: FinishTurnInput,
  ) => Effect.Effect<FinishTurnDecision, PiProtocolError>;
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
  initialGoal: goal,
  claimedCommand: undefined,
  runningCommand: undefined,
  pendingCompletedResult: undefined,
  mailbox,
  completion,
  outcome: undefined,
  interruptRequested: undefined,
  turnInvocations: new Map(),
  activity: undefined,
  inbox: [],
  nextInboxSequence: 0,
  bulletinCursor: 0,
  requestWakeGeneration: 0,
  claimedRequestWakeGeneration: 0,
  plannedWaits: new Map(),
  activeWait: undefined,
  childrenByName: new Map(),
  createdAt: now,
  updatedAt: now,
  terminalAt: undefined,
});

export const makeRegistry = Effect.fn("Brood.makeRegistry")(function* (options: RegistryOptions) {
  const maxAgentAdmissions = options.maxAgentAdmissions;
  if (!Number.isSafeInteger(maxAgentAdmissions) || maxAgentAdmissions <= 0) {
    return yield* Effect.die(
      new Error("Registry maxAgentAdmissions must be a positive safe integer"),
    );
  }

  const maxFailureMessageChars =
    options.maxFailureMessageChars ?? DEFAULT_MAX_FAILURE_MESSAGE_CHARS;
  const nextAgentId = options.nextAgentId ?? (() => makeAgentId(`agent_${crypto.randomUUID()}`));
  const nextWaitId = options.nextWaitId ?? (() => makeWaitId(`wait_${crypto.randomUUID()}`));
  const nextRequestId =
    options.nextRequestId ?? (() => makeRequestId(`request_${crypto.randomUUID()}`));
  const nextCommandToken = options.nextCommandToken ?? (() => crypto.randomUUID());
  const quiescence = yield* Latch.make(false);
  const stateRef = yield* Ref.make<RegistryState>({
    agents: new Map(),
    agentsByPath: new Map(),
    requests: new Map(),
    bulletins: [],
    nextBulletinSequence: 0,
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

  const capacityOf = (state: RegistryState): AgentAdmissionCapacity => ({
    limit: maxAgentAdmissions,
    used: state.agents.size,
    remaining: maxAgentAdmissions - state.agents.size,
  });

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

  // ── Admission ─────────────────────────────────────────────────────────────

  const admissionCapacity = Ref.get(stateRef).pipe(Effect.map(capacityOf));

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
      path: makeAgentPath("root"),
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
              reason: "AlreadyStarted",
              message: "This registry has already admitted or closed its root",
            }),
          ),
        );
      }
      const agents = new Map(state.agents);
      agents.set(id, entry);
      const agentsByPath = new Map(state.agentsByPath);
      agentsByPath.set(registered.path, registered.id);
      return {
        next: {
          ...state,
          agents,
          agentsByPath,
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
    const beforePreparation = yield* Ref.get(stateRef);
    const knownParent = beforePreparation.agents.get(input.parentId);
    if (knownParent === undefined) {
      return yield* Effect.fail(new UnknownAgent({ agentId: input.parentId }));
    }
    const paths = yield* Effect.forEach(input.children, (child) =>
      decodeAgentPath(`${knownParent.path}/${child.name}`).pipe(
        Effect.mapError(
          () =>
            new DelegateRejected({
              reason: "PathTooLong",
              message: `Delegating ${child.name} would exceed the canonical path limit; use a shorter child name before retrying the batch.`,
            }),
        ),
      ),
    );
    const registeredAt = yield* Clock.currentTimeMillis;
    const prepared = yield* Effect.forEach(input.children, (child, index) =>
      Effect.gen(function* () {
        const path = paths[index];
        if (path === undefined) {
          return yield* Effect.die(
            new RegistryInvariantDefect("Validated child paths changed length"),
          );
        }
        const registered: RegisteredAgent = {
          id: nextAgentId(),
          name: child.name,
          path,
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

    return yield* transact((state): Transition<BatchRegistration, DelegateError | UnknownAgent> => {
      return withAgent<BatchRegistration, DelegateError>(state, input.parentId, (parent) => {
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
        const claimed = withInvocation(
          parent,
          input.invocationId,
          "delegate",
          (message) => new DelegateRejected({ reason: "DuplicateInvocationId", message }),
        );
        if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
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
        if (state.agents.size + input.children.length > maxAgentAdmissions) {
          return noChange(
            state,
            Result.fail(
              new AgentAdmissionLimitExceeded({
                requested: input.children.length,
                capacity: capacityOf(state),
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
        const agentsByPath = new Map(state.agentsByPath);
        const childrenByName = new Map(parent.childrenByName);
        for (const child of prepared) {
          if (!child.registered.path.startsWith(`${parent.path}/`)) {
            throw new RegistryInvariantDefect("Parent path changed during batch preparation");
          }
          const registered = child.registered;
          agents.set(registered.id, { ...child.entry, ...registered });
          agentsByPath.set(registered.path, registered.id);
          childrenByName.set(registered.name, registered.id);
        }
        const plannedWaits = new Map(claimed.success.plannedWaits);
        if (input.wait === "all") {
          plannedWaits.set(input.invocationId, {
            tool: "delegate",
            dependencies: prepared.map(({ registered }) => registered.id),
            requests: [],
          });
        }
        agents.set(parent.id, {
          ...claimed.success,
          childrenByName,
          plannedWaits,
          updatedAt: registeredAt,
        });

        const next: RegistryState = {
          ...state,
          agents,
          agentsByPath,
          nonterminalCount: state.nonterminalCount + prepared.length,
        };
        return {
          next,
          actions: prepared.map(({ entry }) => PostCommitAction.Open({ latch: entry.mailbox })),
          result: Result.succeed({
            children: prepared.map(({ registered }) => {
              const stored = agents.get(registered.id);
              if (stored === undefined) {
                throw new RegistryInvariantDefect(`Registered child ${registered.id} is missing`);
              }
              return stored;
            }),
            capacityAfterCommit: capacityOf(next),
          }),
        };
      });
    });
  });

  // ── Peer discovery ──────────────────────────────────────────────────────

  const addressableState = (status: AgentStatus): AgentDirectoryEntry["state"] => {
    switch (status) {
      case "Queued":
        return "queued";
      case "Starting":
        return "starting";
      case "Running":
        return "running";
      case "Waiting":
        return "waiting";
      case "Completed":
      case "Failed":
      case "Interrupted":
        throw new RegistryInvariantDefect(`Terminal status ${status} is not addressable`);
    }
  };

  const listAgents = Effect.fn("Brood.Registry.listAgents")(function* (
    callerId: AgentId,
    input: ListAgentsInput,
  ) {
    const state = yield* Ref.get(stateRef);
    const caller = state.agents.get(callerId);
    if (caller === undefined) {
      return yield* Effect.die(new RegistryInvariantDefect(`Missing caller ${callerId}`));
    }
    const eligible = Array.from(state.agents.values())
      .filter(
        (entry) =>
          entry.id !== callerId &&
          entry.outcome === undefined &&
          (input.after === undefined || entry.path > input.after),
      )
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const self = { path: caller.path };
    const agents: Array<AgentDirectoryEntry> = [];
    for (const [index, entry] of eligible.entries()) {
      if (agents.length >= MAX_DIRECTORY_PAGE_ITEMS) break;
      const unresolvedDependencies = withTargets(
        entry.activeWait?.dependencies ?? [],
        plannedDependencies(entry),
      ).filter((dependencyId) => {
        const dependency = state.agents.get(dependencyId);
        if (dependency === undefined) {
          throw new RegistryInvariantDefect(`Missing dependency ${dependencyId}`);
        }
        return dependency.outcome === undefined;
      });
      const unresolvedRequestRecipients = withTargets(
        entry.activeWait?.requests ?? [],
        plannedRequests(entry),
      ).flatMap((requestId) => {
        const request = state.requests.get(requestId);
        if (request === undefined) {
          throw new RegistryInvariantDefect(`Missing request ${requestId}`);
        }
        if (request.state._tag !== "Open") return [];
        if (!state.agents.has(request.recipientId)) {
          throw new RegistryInvariantDefect(`Missing recipient ${request.recipientId}`);
        }
        return [request.recipientId];
      });
      const projected: AgentDirectoryEntry = {
        path: entry.path,
        name: entry.name,
        state: addressableState(entry.status),
        profile: entry.profile.name,
        ...(entry.activity === undefined ? {} : { activity: entry.activity }),
        waitingFor: {
          agentCompletions: unresolvedDependencies.length,
          replies: unresolvedRequestRecipients.length,
        },
        waitingForCaller:
          unresolvedDependencies.includes(callerId) ||
          unresolvedRequestRecipients.includes(callerId),
      };
      const candidateAgents = [...agents, projected];
      const candidateNextAfter = index < eligible.length - 1 ? projected.path : undefined;
      const candidateResult: ListAgentsResult = {
        self,
        agents: candidateAgents,
        ...(candidateNextAfter === undefined ? {} : { nextAfter: candidateNextAfter }),
      };
      if (Array.from(JSON.stringify(candidateResult)).length > MAX_TOOL_RESULT_CHARS) {
        break;
      }
      agents.push(projected);
    }
    if (eligible.length > 0 && agents.length === 0) {
      throw new RegistryInvariantDefect(
        "MAX_TOOL_RESULT_CHARS cannot hold one complete directory entry",
      );
    }
    const nextAfter = eligible.length > agents.length ? agents.at(-1)?.path : undefined;
    return {
      self,
      agents,
      ...(nextAfter === undefined ? {} : { nextAfter }),
    };
  });

  const nextSafeCounter = (current: number, label: string): number => {
    if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
      throw new RegistryInvariantDefect(`${label} exhausted its safe integer range`);
    }
    return current + 1;
  };

  const withInvocation = <E>(
    entry: AgentEntry,
    invocationId: ToolInvocationId,
    operation: ToolOperationName,
    makeError: (message: string) => E,
  ): Result.Result<AgentEntry, E> => {
    const existing = entry.turnInvocations.get(invocationId);
    if (existing !== undefined) {
      return Result.fail(
        makeError(
          `Tool invocation ${invocationId} was already committed by ${existing} during this agent turn; do not reuse tool-call IDs.`,
        ),
      );
    }
    const turnInvocations = new Map(entry.turnInvocations);
    turnInvocations.set(invocationId, operation);
    return Result.succeed({ ...entry, turnInvocations });
  };

  const callerOrDie = (state: RegistryState, callerId: AgentId): AgentEntry => {
    const caller = state.agents.get(callerId);
    if (caller === undefined) {
      throw new RegistryInvariantDefect(`Missing caller ${callerId}`);
    }
    if (caller.outcome !== undefined) {
      throw new RegistryInvariantDefect(`Terminal caller ${callerId} used a communication tool`);
    }
    return caller;
  };

  const setActivity = Effect.fn("Brood.Registry.setActivity")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SetActivityInput,
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<SetActivityResult, SetActivityRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "set_activity",
        (message) => new SetActivityRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const activity = input.activity === null ? undefined : input.activity;
      return {
        next: replaceAgent(state, { ...claimed.success, activity, updatedAt }),
        actions: [],
        result: Result.succeed(activity === undefined ? {} : { activity }),
      };
    });
  });

  const sendMessage = Effect.fn("Brood.Registry.sendMessage")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SendMessageInput,
  ) {
    const deliveredAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<SendMessageResult, SendMessageRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "send_message",
        (message) => new SendMessageRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const recipientId = state.agentsByPath.get(input.to);
      if (recipientId === undefined) {
        return noChange(
          state,
          Result.fail(
            new SendMessageRejected({
              reason: "UnknownRecipient",
              recipient: input.to,
              message: `No addressable agent exists at ${input.to}; call list_agents and retry with a listed canonical path.`,
            }),
          ),
        );
      }
      if (recipientId === callerId) {
        return noChange(
          state,
          Result.fail(
            new SendMessageRejected({
              reason: "SelfRecipient",
              recipient: input.to,
              message:
                "An agent cannot send a message to itself; retain the information locally instead.",
            }),
          ),
        );
      }
      const recipient = state.agents.get(recipientId);
      if (recipient === undefined) {
        throw new RegistryInvariantDefect(`Path index points to missing agent ${recipientId}`);
      }
      if (recipient.outcome !== undefined) {
        return noChange(
          state,
          Result.fail(
            new SendMessageRejected({
              reason: "RecipientTerminal",
              recipient: input.to,
              message: `${input.to} is terminal and cannot read new messages; choose an addressable agent or write durable context under .brood/shared/.`,
            }),
          ),
        );
      }
      const unreadMessages = recipient.inbox.filter((item) => item._tag === "Message").length;
      if (unreadMessages >= MAX_UNREAD_MESSAGES_PER_AGENT) {
        return noChange(
          state,
          Result.fail(
            new SendMessageRejected({
              reason: "RecipientMessageCapacityExceeded",
              recipient: input.to,
              message: `${input.to} has ${MAX_UNREAD_MESSAGES_PER_AGENT} unread passive messages; retry later, choose another agent, or write the information under .brood/shared/.`,
            }),
          ),
        );
      }
      const sequence = nextSafeCounter(recipient.nextInboxSequence, "Inbox sequence");
      const agents = new Map(state.agents);
      agents.set(callerId, { ...claimed.success, updatedAt: deliveredAt });
      agents.set(recipientId, {
        ...recipient,
        inbox: [
          ...recipient.inbox,
          { _tag: "Message", sequence, fromId: callerId, body: input.message },
        ],
        nextInboxSequence: sequence,
        updatedAt: deliveredAt,
      });
      return {
        next: { ...state, agents },
        actions: [],
        result: Result.succeed({
          to: recipient.path,
          recipientState: addressableState(recipient.status),
        }),
      };
    });
  });

  const askAgent = Effect.fn("Brood.Registry.askAgent")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: AskAgentInput,
  ) {
    const requestedAt = yield* Clock.currentTimeMillis;
    const requestId = nextRequestId();
    return yield* transact((state): Transition<AskAgentToolDetails, AskAgentRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "ask_agent",
        (message) => new AskAgentRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const recipientId = state.agentsByPath.get(input.to);
      if (recipientId === undefined) {
        return noChange(
          state,
          Result.fail(
            new AskAgentRejected({
              reason: "UnknownRecipient",
              recipient: input.to,
              message: `No addressable agent exists at ${input.to}; call list_agents and retry with a listed canonical path.`,
            }),
          ),
        );
      }
      if (recipientId === callerId) {
        return noChange(
          state,
          Result.fail(
            new AskAgentRejected({
              reason: "SelfRecipient",
              recipient: input.to,
              message:
                "An agent cannot ask itself a correlated question; continue reasoning locally instead.",
            }),
          ),
        );
      }
      const recipient = state.agents.get(recipientId);
      if (recipient === undefined) {
        throw new RegistryInvariantDefect(`Path index points to missing agent ${recipientId}`);
      }
      if (recipient.outcome !== undefined) {
        return noChange(
          state,
          Result.fail(
            new AskAgentRejected({
              reason: "RecipientTerminal",
              recipient: input.to,
              message: `${input.to} is terminal and cannot answer; choose an addressable agent or continue without the clarification.`,
            }),
          ),
        );
      }
      const incomingRequests = recipient.inbox.filter(
        (item) =>
          item._tag === "Request" && state.requests.get(item.requestId)?.state._tag === "Open",
      ).length;
      if (incomingRequests >= MAX_INCOMING_REQUESTS_PER_AGENT) {
        return noChange(
          state,
          Result.fail(
            new AskAgentRejected({
              reason: "RecipientRequestCapacityExceeded",
              recipient: input.to,
              message: `${input.to} already has ${MAX_INCOMING_REQUESTS_PER_AGENT} open questions; retry later or ask another addressable agent.`,
            }),
          ),
        );
      }
      const retainedTargets = Array.from(state.requests.values()).filter(
        ({ requesterId }) => requesterId === callerId,
      ).length;
      if (retainedTargets >= MAX_REQUEST_TARGETS_PER_WAIT) {
        return noChange(
          state,
          Result.fail(
            new AskAgentRejected({
              reason: "RequestWaitLimitExceeded",
              recipient: input.to,
              message: `This agent already has ${MAX_REQUEST_TARGETS_PER_WAIT} undelivered request outcomes; wait for them before asking another correlated question.`,
            }),
          ),
        );
      }
      if (state.requests.has(requestId)) {
        throw new RegistryInvariantDefect(`Request ID generator reused ${requestId}`);
      }
      const sequence = nextSafeCounter(recipient.nextInboxSequence, "Inbox sequence");
      const wakeGeneration = nextSafeCounter(
        recipient.requestWakeGeneration,
        "Request wake generation",
      );
      const plannedWaits = new Map(claimed.success.plannedWaits);
      plannedWaits.set(invocationId, {
        tool: "ask_agent",
        dependencies: [],
        requests: [requestId],
      });
      const requests = new Map(state.requests);
      requests.set(requestId, {
        id: requestId,
        requesterId: callerId,
        recipientId,
        wakeGeneration,
        question: input.question,
        state: { _tag: "Open" },
      });
      const agents = new Map(state.agents);
      agents.set(callerId, { ...claimed.success, plannedWaits, updatedAt: requestedAt });
      agents.set(recipientId, {
        ...recipient,
        inbox: [...recipient.inbox, { _tag: "Request", sequence, requestId, presented: false }],
        nextInboxSequence: sequence,
        requestWakeGeneration: wakeGeneration,
        updatedAt: requestedAt,
      });
      return {
        next: { ...state, agents, requests },
        actions: [PostCommitAction.Open({ latch: recipient.mailbox })],
        result: Result.succeed({
          version: 1,
          request: requestId,
          to: recipient.path,
          recipientState: addressableState(recipient.status),
          broodControl: { version: 1, kind: "suspend", invocationId },
        }),
      };
    });
  });

  const inboxProjectionSize = (value: unknown): number => Array.from(JSON.stringify(value)).length;

  const readMessages = Effect.fn("Brood.Registry.readMessages")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadMessagesInput,
  ) {
    const readAt = yield* Clock.currentTimeMillis;
    const limit = input.limit ?? MAX_INBOX_READ_ITEMS;
    return yield* transact((state): Transition<ReadMessagesResult, ReadMessagesRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "read_messages",
        (message) => new ReadMessagesRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));

      const openRequestEntries = caller.inbox.filter(
        (item): item is Extract<InboxEntry, { _tag: "Request" }> => {
          if (item._tag !== "Request") return false;
          return state.requests.get(item.requestId)?.state._tag === "Open";
        },
      );
      const unpresented = openRequestEntries.filter(({ presented }) => !presented);
      const presented = openRequestEntries.filter(({ presented: wasPresented }) => wasPresented);
      const messages = caller.inbox.filter(
        (item): item is Extract<InboxEntry, { _tag: "Message" }> => item._tag === "Message",
      );
      const ordered: ReadonlyArray<InboxEntry> = [...unpresented, ...messages, ...presented];
      const selected: Array<{
        readonly source: InboxEntry;
        readonly item: ReadMessagesResult["items"][number];
      }> = [];
      for (const source of ordered) {
        if (selected.length >= limit) break;
        const request =
          source._tag === "Request" ? state.requests.get(source.requestId) : undefined;
        if (source._tag === "Request" && request === undefined)
          throw new RegistryInvariantDefect(`Inbox references missing ${source.requestId}`);
        const senderId = source._tag === "Message" ? source.fromId : request?.requesterId;
        const sender = senderId === undefined ? undefined : state.agents.get(senderId);
        if (sender === undefined) {
          throw new RegistryInvariantDefect("Inbox item has no retained sender attribution");
        }
        let item: ReadMessagesResult["items"][number];
        if (source._tag === "Message") {
          item = { kind: "message", from: sender.path, message: source.body };
        } else {
          if (request === undefined)
            throw new RegistryInvariantDefect(`Inbox references missing ${source.requestId}`);
          item = {
            kind: "request",
            request: source.requestId,
            from: sender.path,
            question: request.question,
          };
        }
        const projectedChars = inboxProjectionSize({
          items: [...selected.map(({ item: selectedItem }) => selectedItem), item],
          inbox: {
            unreadMessages: caller.inbox.length,
            openRequests: caller.inbox.length,
            omittedFromPage: ordered.length,
          },
        });
        if (projectedChars + 512 > MAX_TOOL_RESULT_CHARS) break;
        selected.push({ source, item });
      }
      const selectedMessages = new Set(
        selected.flatMap(({ source }) => (source._tag === "Message" ? [source.sequence] : [])),
      );
      const selectedRequests = new Set(
        selected.flatMap(({ source }) => (source._tag === "Request" ? [source.requestId] : [])),
      );
      const retainedInbox = caller.inbox.flatMap((item): ReadonlyArray<InboxEntry> => {
        if (item._tag === "Message") return selectedMessages.has(item.sequence) ? [] : [item];
        return selectedRequests.has(item.requestId) ? [] : [item];
      });
      const presentedRequests = selected.flatMap(({ source }): ReadonlyArray<InboxEntry> =>
        source._tag === "Request" ? [{ ...source, presented: true }] : [],
      );
      const inbox = [...retainedInbox, ...presentedRequests];
      const unreadMessages = inbox.filter((item) => item._tag === "Message").length;
      const openRequests = inbox.filter(
        (item) =>
          item._tag === "Request" && state.requests.get(item.requestId)?.state._tag === "Open",
      ).length;
      const result: ReadMessagesResult = {
        items: selected.map(({ item }) => item),
        inbox: {
          unreadMessages,
          openRequests,
          omittedFromPage: ordered.length - selected.length,
        },
      };
      return {
        next: replaceAgent(state, { ...claimed.success, inbox, updatedAt: readAt }),
        actions: [],
        result: Result.succeed(result),
      };
    });
  });

  const replyToRequest = Effect.fn("Brood.Registry.replyToRequest")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReplyToRequestInput,
  ) {
    const repliedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<ReplyToRequestResult, ReplyRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "reply_to_request",
        (message) => new ReplyRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const request = state.requests.get(input.request);
      if (request === undefined) {
        return noChange(
          state,
          Result.fail(
            new ReplyRejected({
              reason: "UnknownOrClosedRequest",
              request: input.request,
              message: `Request ${input.request} is unknown or already closed; call read_messages and reply to an open request ID.`,
            }),
          ),
        );
      }
      if (request.recipientId !== callerId) {
        return noChange(
          state,
          Result.fail(
            new ReplyRejected({
              reason: "NotRecipient",
              request: input.request,
              message: `This agent is not the recipient of ${input.request}; only the addressed agent may reply.`,
            }),
          ),
        );
      }
      if (request.state._tag === "Replied") {
        return noChange(
          state,
          Result.fail(
            new ReplyRejected({
              reason: "AlreadyReplied",
              request: input.request,
              message: `Request ${input.request} already has a reply; continue with other work instead of replacing it.`,
            }),
          ),
        );
      }
      if (request.state._tag === "Unavailable") {
        return noChange(
          state,
          Result.fail(
            new ReplyRejected({
              reason: "UnknownOrClosedRequest",
              request: input.request,
              message: `Request ${input.request} is closed because an endpoint became unavailable; call read_messages for other open requests.`,
            }),
          ),
        );
      }
      const requester = state.agents.get(request.requesterId);
      if (requester === undefined || requester.outcome !== undefined) {
        throw new RegistryInvariantDefect(`Open request ${request.id} has no live requester`);
      }
      const requests = new Map(state.requests);
      requests.set(request.id, { ...request, state: { _tag: "Replied", reply: input.message } });
      const agents = new Map(state.agents);
      agents.set(callerId, {
        ...claimed.success,
        inbox: caller.inbox.filter(
          (item) => item._tag !== "Request" || item.requestId !== request.id,
        ),
        updatedAt: repliedAt,
      });
      let next: RegistryState = { ...state, agents, requests };
      const actions: Array<PostCommitAction> = [];
      const currentRequester = next.agents.get(requester.id);
      if (
        currentRequester !== undefined &&
        currentRequester.status === "Waiting" &&
        activeWaitSatisfied(next, currentRequester)
      ) {
        const queued: AgentEntry = { ...currentRequester, status: "Queued", updatedAt: repliedAt };
        const queuedAgents = new Map(next.agents);
        queuedAgents.set(queued.id, queued);
        next = { ...next, agents: queuedAgents };
        actions.push(PostCommitAction.Open({ latch: queued.mailbox }));
      }
      return {
        next,
        actions,
        result: Result.succeed({ request: request.id, to: requester.path }),
      };
    });
  });

  const postBulletin = Effect.fn("Brood.Registry.postBulletin")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: PostBulletinInput,
  ) {
    const postedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<PostBulletinResult, PostBulletinRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "post_bulletin",
        (message) => new PostBulletinRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const sequence = nextSafeCounter(state.nextBulletinSequence, "Bulletin sequence");
      const authored = state.bulletins.filter(({ authorId }) => authorId === callerId);
      const evictedSequence =
        authored.length >= MAX_BULLETINS_PER_AUTHOR ? authored[0]?.sequence : undefined;
      const retained =
        evictedSequence === undefined
          ? state.bulletins
          : state.bulletins.filter(({ sequence: candidate }) => candidate !== evictedSequence);
      return {
        next: {
          ...replaceAgent(state, { ...claimed.success, updatedAt: postedAt }),
          bulletins: [
            ...retained,
            {
              sequence,
              authorId: callerId,
              authorPath: caller.path,
              body: input.message,
            },
          ],
          nextBulletinSequence: sequence,
        },
        actions: [],
        result: Result.succeed({ author: caller.path }),
      };
    });
  });

  const readBulletins = Effect.fn("Brood.Registry.readBulletins")(function* (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadBulletinsInput,
  ) {
    const readAt = yield* Clock.currentTimeMillis;
    const limit = input.limit ?? MAX_BULLETIN_READ_ITEMS;
    return yield* transact((state): Transition<ReadBulletinsResult, ReadBulletinsRejected> => {
      const caller = callerOrDie(state, callerId);
      const claimed = withInvocation(
        caller,
        invocationId,
        "read_bulletins",
        (message) => new ReadBulletinsRejected({ reason: "DuplicateInvocationId", message }),
      );
      if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
      const unseen = state.bulletins.filter(({ sequence }) => sequence > caller.bulletinCursor);
      const selected: Array<{ readonly record: BulletinRecord; readonly post: BulletinPost }> = [];
      for (const record of unseen) {
        if (selected.length >= limit) break;
        const post: BulletinPost = { author: record.authorPath, message: record.body };
        const projectedChars = inboxProjectionSize({
          posts: [...selected.map(({ post: selectedPost }) => selectedPost), post],
          bulletin: { remaining: unseen.length },
        });
        if (projectedChars + 512 > MAX_TOOL_RESULT_CHARS) break;
        selected.push({ record, post });
      }
      const bulletinCursor = selected.at(-1)?.record.sequence ?? caller.bulletinCursor;
      return {
        next: replaceAgent(state, { ...claimed.success, bulletinCursor, updatedAt: readAt }),
        actions: [],
        result: Result.succeed({
          posts: selected.map(({ post }) => post),
          bulletin: {
            remaining: state.bulletins.filter(({ sequence }) => sequence > bulletinCursor).length,
          },
        }),
      };
    });
  });

  // ── Waits: plan during a turn, activate after suspension ─────────────────

  const planWait = Effect.fn("Brood.Registry.planWait")(function* (input: PlanWaitInput) {
    const plannedAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<WaitPlanResult, WaitRejected | UnknownAgent> =>
      withAgent<WaitPlanResult, WaitRejected>(state, input.parentId, (parent) => {
        const claimed = withInvocation(
          parent,
          input.invocationId,
          "wait_for_agents",
          (message) => new WaitRejected({ reason: "DuplicateInvocationId", message }),
        );
        if (Result.isFailure(claimed)) return noChange(state, Result.fail(claimed.failure));
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

        const canonicalTargetIds = [...targetIds];
        const allTerminal = canonicalTargetIds.every((targetId) => {
          const target = state.agents.get(targetId);
          return target !== undefined && target.outcome !== undefined;
        });
        const plannedWaits = new Map(claimed.success.plannedWaits);
        if (!allTerminal) {
          plannedWaits.set(input.invocationId, {
            tool: "wait_for_agents",
            dependencies: canonicalTargetIds,
            requests: [],
          });
        }
        const next = replaceAgent(state, {
          ...claimed.success,
          plannedWaits,
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

  // ── Installation, status marks, and the command mailbox ──────────────────

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
  const markStarting = Effect.fn("Brood.Registry.markStarting")(function* (id: AgentId) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* transitionStatus(id, QUEUED, "Starting", updatedAt);
  });

  const openIncomingRequests = (
    state: RegistryState,
    entry: AgentEntry,
  ): ReadonlyArray<RequestRecord> =>
    entry.inbox.flatMap((item) => {
      if (item._tag !== "Request") return [];
      const request = state.requests.get(item.requestId);
      return request?.state._tag === "Open" ? [request] : [];
    });

  const hasNewOpenRequest = (state: RegistryState, entry: AgentEntry): boolean =>
    openIncomingRequests(state, entry).some(
      ({ wakeGeneration }) => wakeGeneration > entry.claimedRequestWakeGeneration,
    );

  const activeWaitSatisfied = (state: RegistryState, entry: AgentEntry): boolean => {
    const active = entry.activeWait;
    if (active === undefined) return false;
    return (
      active.dependencies.every((id) => state.agents.get(id)?.outcome !== undefined) &&
      active.requests.every((id) => {
        const request = state.requests.get(id);
        return request !== undefined && request.state._tag !== "Open";
      })
    );
  };

  const coordinationNotice = (state: RegistryState, entry: AgentEntry): AgentCommand["notice"] => {
    const notice = {
      unreadMessages: entry.inbox.filter(({ _tag }) => _tag === "Message").length,
      openRequests: openIncomingRequests(state, entry).length,
      unseenBulletins: state.bulletins.filter(({ sequence }) => sequence > entry.bulletinCursor)
        .length,
    };
    return notice.unreadMessages === 0 && notice.openRequests === 0 && notice.unseenBulletins === 0
      ? undefined
      : notice;
  };

  const requestOutcomeFor = (state: RegistryState, requestId: RequestId): PeerRequestOutcome => {
    const request = state.requests.get(requestId);
    if (request === undefined || request.state._tag === "Open") {
      throw new RegistryInvariantDefect(`Request ${requestId} is not settled`);
    }
    const recipient = state.agents.get(request.recipientId);
    if (recipient === undefined) {
      throw new RegistryInvariantDefect(`Request ${requestId} has no recipient`);
    }
    if (request.state._tag === "Replied") {
      return {
        _tag: "Replied",
        request: request.id,
        to: recipient.path,
        reply: request.state.reply,
      };
    }
    return {
      _tag: "Unavailable",
      request: request.id,
      to: recipient.path,
      recipientState: request.state.recipientState,
    };
  };

  type TakeDecision = Data.TaggedEnum<{
    Command: { readonly claim: CommandClaim };
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
      const token = makeCommandToken(nextCommandToken());

      const decision = yield* transact((state): Transition<TakeDecision, UnknownAgent> => {
        return withAgent<TakeDecision, never>(state, id, (entry) => {
          if (entry.interruptRequested !== undefined) {
            return noChange(
              state,
              Result.succeed(TakeDecision.Interrupted({ reason: entry.interruptRequested })),
            );
          }
          if (entry.claimedCommand !== undefined || entry.runningCommand !== undefined) {
            throw new RegistryInvariantDefect(`Agent ${id} already owns a command`);
          }
          const trigger: CommandTrigger | undefined =
            entry.initialGoal !== undefined
              ? "initial"
              : activeWaitSatisfied(state, entry)
                ? "wait-satisfied"
                : hasNewOpenRequest(state, entry)
                  ? "coordination"
                  : entry.status === "Queued"
                    ? "coordination"
                    : undefined;
          if (trigger !== undefined) {
            const claim: CommandClaim = { token, trigger };
            return {
              next: replaceAgent(state, {
                ...entry,
                status: "Queued",
                claimedCommand: claim,
                updatedAt: takenAt,
              }),
              actions: [],
              result: Result.succeed(TakeDecision.Command({ claim })),
            };
          }
          if (entry.outcome !== undefined) {
            throw new RegistryInvariantDefect(`Terminal agent ${id} cannot take another command`);
          }
          return noChange(state, Result.succeed(TakeDecision.Empty()));
        });
      });

      const command = yield* TakeDecision.$match(decision, {
        Command: ({ claim }) => Effect.succeed(Option.some(claim)),
        Interrupted: ({ reason }) =>
          Effect.fail({
            _tag: "CommandInterrupted",
            agentId: id,
            reason,
          } satisfies CommandInterrupted),
        Empty: () => Latch.await(current.mailbox).pipe(Effect.as(Option.none<CommandClaim>())),
      });
      if (Option.isSome(command)) return command.value;
    }
  });

  const beginRun = Effect.fn("Brood.Registry.beginRun")(function* (
    id: AgentId,
    token: CommandToken,
  ) {
    const beganAt = yield* Clock.currentTimeMillis;
    return yield* transact((state): Transition<BeginRunResult, UnknownAgent | CommandInterrupted> =>
      withAgent<BeginRunResult, CommandInterrupted>(state, id, (entry) => {
        const claim = entry.claimedCommand;
        if (claim === undefined || claim.token !== token || entry.runningCommand !== undefined) {
          throw new RegistryInvariantDefect(`Command token does not own the next run for ${id}`);
        }
        if (entry.interruptRequested !== undefined) {
          return noChange(
            state,
            Result.fail({
              _tag: "CommandInterrupted",
              agentId: id,
              reason: entry.interruptRequested,
            }),
          );
        }
        const notice = coordinationNotice(state, entry);
        let command: AgentCommand;
        let nextState = state;
        let nextEntry = entry;
        if (entry.initialGoal !== undefined) {
          command = {
            _tag: "InitialGoal",
            goal: entry.initialGoal,
            ...(notice === undefined ? {} : { notice }),
          };
          nextEntry = { ...entry, initialGoal: undefined };
        } else if (activeWaitSatisfied(state, entry)) {
          const active = entry.activeWait;
          if (active === undefined) {
            throw new RegistryInvariantDefect(`Satisfied wait claim for ${id} is no longer ready`);
          }
          const requests = active.requests.map((requestId) => requestOutcomeFor(state, requestId));
          command = {
            _tag: "WaitSatisfied",
            waitId: active.waitId,
            dependencies: outcomesFor(state, active.dependencies),
            requests,
            ...(notice === undefined ? {} : { notice }),
          };
          const retainedRequests = new Map(state.requests);
          for (const requestId of active.requests) retainedRequests.delete(requestId);
          nextState = { ...state, requests: retainedRequests };
          nextEntry = { ...entry, activeWait: undefined };
        } else if (hasNewOpenRequest(state, entry)) {
          const requiredNotice = notice ?? {
            unreadMessages: 0,
            openRequests: openIncomingRequests(state, entry).length,
            unseenBulletins: 0,
          };
          const active = entry.activeWait;
          command = {
            _tag: "CoordinationWake",
            notice: requiredNotice,
            waitingFor: {
              agentCompletions:
                active?.dependencies.filter(
                  (dependency) => state.agents.get(dependency)?.outcome === undefined,
                ).length ?? 0,
              replies:
                active?.requests.filter(
                  (requestId) => state.requests.get(requestId)?.state._tag === "Open",
                ).length ?? 0,
            },
          };
        } else {
          if (entry.activeWait === undefined) {
            if (entry.pendingCompletedResult === undefined) {
              throw new RegistryInvariantDefect(
                `Stale command for ${id} has neither an active wait nor a deferred completion`,
              );
            }
            const fallback: AgentOutcome = {
              _tag: "Completed",
              result: entry.pendingCompletedResult,
            };
            const cleared = replaceAgent(state, {
              ...entry,
              claimedCommand: undefined,
              updatedAt: beganAt,
            });
            const settled = settleTransition(cleared, id, fallback, beganAt, false);
            if (Result.isFailure(settled.result)) {
              throw new RegistryInvariantDefect(`Stale agent ${id} disappeared during settlement`);
            }
            const committed = Option.getOrUndefined(settled.result.success);
            if (committed === undefined) {
              throw new RegistryInvariantDefect(`Stale agent ${id} was already settled`);
            }
            return {
              ...settled,
              result: Result.succeed({ _tag: "Settled", outcome: committed }),
            };
          }
          return {
            next: replaceAgent(state, {
              ...entry,
              status: "Waiting",
              claimedCommand: undefined,
              updatedAt: beganAt,
            }),
            actions: [],
            result: Result.succeed({ _tag: "Stale", status: "Waiting" }),
          };
        }
        const runningCommand: RunningCommand = {
          token,
        };
        nextEntry = {
          ...nextEntry,
          status: "Running",
          claimedCommand: undefined,
          runningCommand,
          pendingCompletedResult: undefined,
          claimedRequestWakeGeneration: entry.requestWakeGeneration,
          turnInvocations: new Map(),
          plannedWaits: new Map(),
          updatedAt: beganAt,
        };
        return {
          next: replaceAgent(nextState, nextEntry),
          actions: [],
          result: Result.succeed({ _tag: "Ready", command }),
        };
      }),
    );
  });

  // ── Terminal settlement ──────────────────────────────────────────────────

  function settleTransition(
    state: RegistryState,
    id: AgentId,
    requestedOutcome: AgentOutcome,
    settledAt: number,
    onlyIfPendingInstallation: boolean,
  ): Transition<Option.Option<AgentOutcome>, UnknownAgent> {
    return withAgent<Option.Option<AgentOutcome>, never>(state, id, (entry) => {
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
        initialGoal: undefined,
        claimedCommand: undefined,
        runningCommand: undefined,
        pendingCompletedResult: undefined,
        turnInvocations: new Map(),
        plannedWaits: new Map(),
        activeWait: undefined,
        activity: undefined,
        inbox: [],
        outcome,
        updatedAt: settledAt,
        terminalAt: settledAt,
      };
      let agents = new Map(state.agents);
      agents.set(id, settled);
      const requests = new Map(state.requests);
      const actions: Array<PostCommitAction> = [
        PostCommitAction.Complete({ deferred: entry.completion, outcome }),
        PostCommitAction.Open({ latch: entry.mailbox }),
      ];
      let recipientTerminalState: "completed" | "failed" | "interrupted";
      switch (outcome._tag) {
        case "Completed":
          recipientTerminalState = "completed";
          break;
        case "Failed":
          recipientTerminalState = "failed";
          break;
        case "Interrupted":
          recipientTerminalState = "interrupted";
          break;
      }
      for (const request of state.requests.values()) {
        if (request.requesterId === id) {
          requests.delete(request.id);
          const recipient = agents.get(request.recipientId);
          if (recipient !== undefined && recipient.outcome === undefined) {
            agents.set(recipient.id, {
              ...recipient,
              inbox: recipient.inbox.filter(
                (item) => item._tag !== "Request" || item.requestId !== request.id,
              ),
              updatedAt: settledAt,
            });
          }
          continue;
        }
        if (request.recipientId === id && request.state._tag === "Open") {
          requests.set(request.id, {
            ...request,
            state: { _tag: "Unavailable", recipientState: recipientTerminalState },
          });
        }
      }
      let next: RegistryState = { ...state, agents, requests };
      for (const candidate of agents.values()) {
        if (
          candidate.status === "Waiting" &&
          candidate.interruptRequested === undefined &&
          activeWaitSatisfied(next, candidate)
        ) {
          const queued: AgentEntry = { ...candidate, status: "Queued", updatedAt: settledAt };
          agents = new Map(agents);
          agents.set(candidate.id, queued);
          next = { ...next, agents };
          actions.push(PostCommitAction.Open({ latch: candidate.mailbox }));
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
  }

  const settle = Effect.fn("Brood.Registry.settle")(function* (id: AgentId, outcome: AgentOutcome) {
    const settledAt = yield* Clock.currentTimeMillis;
    return yield* transact((state) => settleTransition(state, id, outcome, settledAt, false));
  });

  const finishTurn = Effect.fn("Brood.Registry.finishTurn")(function* (input: FinishTurnInput) {
    const finishedAt = yield* Clock.currentTimeMillis;
    const freshWaitId = nextWaitId();
    return yield* transact((state): Transition<FinishTurnDecision, PiProtocolError> => {
      const entry = state.agents.get(input.agentId);
      if (entry === undefined) {
        throw new RegistryInvariantDefect(`Missing running agent ${input.agentId}`);
      }
      if (entry.outcome !== undefined) {
        return noChange(
          state,
          Result.succeed(FinishTurnDecision.Settled({ outcome: entry.outcome })),
        );
      }
      const running = entry.runningCommand;
      if (running === undefined || running.token !== input.commandToken) {
        throw new RegistryInvariantDefect(`Command token does not own the running turn`);
      }

      const protocolError = (message: string) =>
        noChange(state, Result.fail(new PiProtocolError({ agentId: input.agentId, message })));
      let activeWait = entry.activeWait;
      if (input.piOutcome._tag === "Completed") {
        if (entry.plannedWaits.size > 0) {
          return protocolError(
            "The Pi run completed without reporting every successful suspending Brood operation.",
          );
        }
      } else {
        const seenMarkers = new Set<ToolInvocationId>();
        for (const marker of input.piOutcome.markers) {
          if (seenMarkers.has(marker.invocationId)) {
            return protocolError(
              `Suspension marker ${marker.invocationId} appeared more than once in one turn.`,
            );
          }
          seenMarkers.add(marker.invocationId);
          const planned = entry.plannedWaits.get(marker.invocationId);
          if (planned === undefined) {
            return protocolError(
              `Suspension marker ${marker.invocationId} has no matching registry plan in this turn.`,
            );
          }
          if (marker._tag === "AgentWait") {
            if (planned.tool !== marker.tool || planned.requests.length > 0) {
              return protocolError(
                `Suspension marker ${marker.invocationId} does not match its planned ${planned.tool} operation.`,
              );
            }
          } else if (
            planned.tool !== "ask_agent" ||
            planned.requests.length !== 1 ||
            planned.requests[0] !== marker.request
          ) {
            return protocolError(
              `Request marker ${marker.invocationId} does not match its planned request.`,
            );
          }
          const base =
            activeWait ??
            ({ waitId: freshWaitId, dependencies: [], requests: [] } satisfies ActiveWait);
          activeWait = {
            ...base,
            dependencies: withTargets(base.dependencies, planned.dependencies),
            requests: withTargets(base.requests, planned.requests),
          };
        }
        if (seenMarkers.size !== entry.plannedWaits.size) {
          const missing = Array.from(entry.plannedWaits.keys()).filter(
            (invocationId) => !seenMarkers.has(invocationId),
          );
          return protocolError(
            `The suspended Pi run omitted planned Brood marker${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          );
        }
        if (activeWait === undefined) {
          return protocolError("The Pi run suspended without any activated wait target.");
        }
      }

      const reconciled: AgentEntry = {
        ...entry,
        runningCommand: undefined,
        turnInvocations: new Map(),
        plannedWaits: new Map(),
        activeWait,
        updatedAt: finishedAt,
      };
      const reconciledState = replaceAgent(state, reconciled);
      if (entry.interruptRequested !== undefined) {
        const settled = settleTransition(
          reconciledState,
          entry.id,
          { _tag: "Interrupted", reason: entry.interruptRequested },
          finishedAt,
          false,
        );
        if (Result.isFailure(settled.result)) {
          throw new RegistryInvariantDefect(`Running agent ${entry.id} disappeared during finish`);
        }
        const committed = Option.getOrUndefined(settled.result.success);
        if (committed === undefined) {
          throw new RegistryInvariantDefect(`Running agent ${entry.id} was already settled`);
        }
        return {
          ...settled,
          result: Result.succeed(FinishTurnDecision.Settled({ outcome: committed })),
        };
      }
      if (activeWaitSatisfied(reconciledState, reconciled)) {
        return {
          next: replaceAgent(reconciledState, { ...reconciled, status: "Queued" }),
          actions: [PostCommitAction.Open({ latch: reconciled.mailbox })],
          result: Result.succeed(FinishTurnDecision.RunNext()),
        };
      }
      if (hasNewOpenRequest(reconciledState, reconciled)) {
        const pendingCompletedResult =
          input.piOutcome._tag === "Completed" && "completedResult" in input
            ? input.completedResult
            : undefined;
        return {
          next: replaceAgent(reconciledState, {
            ...reconciled,
            status: "Queued",
            pendingCompletedResult,
          }),
          actions: [PostCommitAction.Open({ latch: reconciled.mailbox })],
          result: Result.succeed(FinishTurnDecision.RunNext()),
        };
      }
      if (reconciled.activeWait !== undefined) {
        const unresolvedDependencies = reconciled.activeWait.dependencies.filter(
          (dependency) => reconciledState.agents.get(dependency)?.outcome === undefined,
        );
        const unresolvedRequestRecipients = reconciled.activeWait.requests.flatMap((requestId) => {
          const request = reconciledState.requests.get(requestId);
          if (request === undefined) {
            throw new RegistryInvariantDefect(`Active wait references missing ${requestId}`);
          }
          return request.state._tag === "Open" ? [request.recipientId] : [];
        });
        return {
          next: replaceAgent(reconciledState, { ...reconciled, status: "Waiting" }),
          actions: [],
          result: Result.succeed(
            FinishTurnDecision.Park({
              waitId: reconciled.activeWait.waitId,
              targetIds: withTargets(unresolvedDependencies, unresolvedRequestRecipients),
            }),
          ),
        };
      }
      if (input.piOutcome._tag !== "Completed") {
        return protocolError("The Pi run suspended without leaving an active wait.");
      }
      if (!("completedResult" in input)) {
        throw new RegistryInvariantDefect("Completed turn has no normalized agent result");
      }
      const completed: AgentOutcome = { _tag: "Completed", result: input.completedResult };
      const settled = settleTransition(reconciledState, entry.id, completed, finishedAt, false);
      if (Result.isFailure(settled.result)) {
        throw new RegistryInvariantDefect(`Running agent ${entry.id} disappeared during finish`);
      }
      const committed = Option.getOrUndefined(settled.result.success);
      if (committed === undefined) {
        throw new RegistryInvariantDefect(`Running agent ${entry.id} was already settled`);
      }
      return {
        ...settled,
        result: Result.succeed(FinishTurnDecision.Settled({ outcome: committed })),
      };
    });
  });

  const awaitOutcome = Effect.fn("Brood.Registry.awaitOutcome")(function* (id: AgentId) {
    const state = yield* Ref.get(stateRef);
    const entry = state.agents.get(id);
    if (entry === undefined) return yield* Effect.fail(new UnknownAgent({ agentId: id }));
    return yield* Deferred.await(entry.completion);
  });

  // ── Interruption, shutdown, and drain ────────────────────────────────────

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

  // ── Snapshot ─────────────────────────────────────────────────────────────

  const snapshot = Ref.get(stateRef).pipe(
    Effect.map((state): RegistrySnapshot => {
      const agents = Array.from(state.agents.values(), (entry): AgentSnapshot => {
        const dependencyIds = withTargets(
          entry.activeWait?.dependencies ?? [],
          plannedDependencies(entry),
        ).filter((dependencyId) => {
          const dependency = state.agents.get(dependencyId);
          if (dependency === undefined) {
            throw new RegistryInvariantDefect(`Wait references missing agent ${dependencyId}`);
          }
          return dependency.outcome === undefined;
        });
        const requestIds = withTargets(entry.activeWait?.requests ?? [], plannedRequests(entry));
        const requestRecipientIds = requestIds.flatMap((requestId) => {
          const request = state.requests.get(requestId);
          if (request === undefined) {
            throw new RegistryInvariantDefect(`Wait references missing request ${requestId}`);
          }
          return request.state._tag === "Open" ? [request.recipientId] : [];
        });
        return {
          id: entry.id,
          name: entry.name,
          path: entry.path,
          parentId: entry.parentId,
          profile: entry.profile,
          status: entry.status,
          installation: entry.installation,
          waitTargets: withTargets(dependencyIds, requestRecipientIds),
          hasPendingCommand:
            entry.initialGoal !== undefined ||
            entry.claimedCommand !== undefined ||
            activeWaitSatisfied(state, entry) ||
            hasNewOpenRequest(state, entry) ||
            entry.status === "Queued",
          interruptRequested: entry.interruptRequested,
          outcome: entry.outcome,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          terminalAt: entry.terminalAt,
          activity: entry.activity,
        };
      });
      return {
        agents,
        rootId: state.rootId,
        accepting: state.accepting,
        nonterminalCount: state.nonterminalCount,
        pendingInstallationCount: agents.filter(({ installation }) => installation === "Pending")
          .length,
        admissionCapacity: capacityOf(state),
        retainedBulletinCount: state.bulletins.length,
      };
    }),
  );

  return {
    registerRoot,
    registerBatch,
    admissionCapacity,
    listAgents,
    setActivity,
    sendMessage,
    askAgent,
    readMessages,
    replyToRequest,
    postBulletin,
    readBulletins,
    settle,
    planWait,
    markInstalled,
    markStarting,
    takePendingCommand,
    beginRun,
    finishTurn,
    awaitOutcome,
    requestInterrupt,
    beginShutdown,
    settlePendingInstallations,
    awaitQuiescence,
    snapshot,
  } satisfies AgentRegistry;
});
