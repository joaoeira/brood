# Brood admission awareness and inherited run instructions

Status: accepted and implemented (2026-08-07); retained as the design record

Date: 2026-08-07

Audience: design reviewers and the implementer

## 1. Decision

Brood should make its global agent-admission constraint visible to every agent and should carry a bounded, operator-authored run charter into every descendant. It should not yet impose subtree budgets, branch quotas, reservations, or a general policy plug-in.

The concrete v1 change is:

1. Rename `maxAgents` to `maxAgentAdmissions` so the configuration states what it actually limits.
2. Define one public `AgentAdmissionCapacity` schema derived from the registry's authoritative state.
3. Show a fresh capacity snapshot to an agent before every initial or resumed Pi run.
4. Return the post-commit capacity in every successful `delegate` result.
5. Return a typed, quantitative error when a batch does not fit, without partially admitting it.
6. Let a Brood run carry optional bounded `instructions` that every agent inherits unchanged.
7. Run a falsifying experiment with visibility and inherited instructions but no branch quotas before adding stronger allocation policy.

The aim is not to teach agents a preferred hierarchy. Brood remains neutral about breadth and depth. The aim is to expose the scarce global fact that agents currently cannot observe and to preserve run-wide policy as delegation moves away from the root.

## 2. Why this change

`maxAgents` currently behaves as a total-spend ceiling on agent admissions. The root consumes one admission. Every successfully registered child consumes another. A completed, failed, or interrupted agent does not return its admission. The counter therefore increases monotonically until the run drains or reaches the configured limit.

That is categorically different from `maxConcurrency`. Concurrency is reusable work-in-progress capacity: a run acquires a permit and later releases it. Admission is cumulative: once spent, it never replenishes during the run. Calling both of these things “agent limits” conceals the most important operational distinction in Brood.

The second worldbuilding run demonstrated that the runtime mechanics work. Eleven agents completed without deadlock, recursive delegation worked, waiting parents released run permits, and the resulting wiki was substantially better than the first. It did not establish that branch quotas are the correct product abstraction. The successful prompt simultaneously changed topology, sequencing, delegation quotas, and shared-world instructions. That is too confounded to justify encoding a hierarchy into Brood.

The first failure had at least three causes:

- agents could not see the globally remaining admissions;
- descendants did not inherit the root's durable allocation and sequencing charter;
- work was delegated before its prerequisites were sufficiently stable.

Only the first two are runtime information problems. The third is a planning problem, and a subtree budget does not solve it. A budget can stop one branch from consuming everything, but it cannot make premature work causally sound.

The proposed change therefore tests the smallest plausible intervention: give every decision-maker the same monotonic global capacity fact and the same run-wide instructions. If that fails repeatedly, Brood will have evidence for a stronger mechanism. Adding hierarchical budgets now would turn one successful prompt topology into permanent scheduler policy before the topology-neutral alternative has even been tested.

## 3. Terminology and invariants

The implementation and documentation should use these terms consistently:

- **Agent admission**: the irreversible creation of one logical agent record during a run.
- **Admission limit**: the maximum total number of agent records that may be admitted, including the root.
- **Admission capacity**: `{ limit, used, remaining }` at one registry snapshot.
- **Run slot**: one reusable concurrency permit held only while an agent is actively opening or prompting Pi.
- **Run instructions**: a static operator-authored charter inherited by every agent in one Brood run.
- **Local goal**: the task written by the parent for one delegated child, or the root goal for the root.

The admission invariant is:

```text
remaining = limit - used
0 <= used <= limit
```

`used` includes the root, nonterminal agents, terminal agents, and agents whose controller installation or Pi startup has not completed. It changes only when root registration or an entire child batch commits. It never decreases. Failed Pi startup, failed execution, interruption, and normal completion do not refund admission.

An invalid request that fails before registration does not consume admission. This includes malformed tool input, duplicate child names, parent-lifetime name collisions, unknown profiles, duplicate invocation IDs, and a whole batch that does not fit.

The admission limit remains a safety ceiling. It is not a target, a promise that every slot should be spent, a token budget, or an estimate of economic cost. A run may correctly finish with substantial capacity unused.

## 4. Configuration contract

### 4.1 Rename `maxAgents`

The configuration field becomes `maxAgentAdmissions`:

```ts
const LEGACY_MAX_AGENTS = "`maxAgents` was renamed to `maxAgentAdmissions`; remove the old key";

const BroodConfigFields = Schema.Struct({
  // existing fields...
  maxConcurrency: PositiveInt,
  maxAgentAdmissions: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(128))),
  maxAgents: Schema.optionalKey(Schema.Never.annotate({ message: LEGACY_MAX_AGENTS })),
  maxRunInstructionsChars: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4_000))),
});
```

The existing cross-field constraint becomes:

```text
maxConcurrency <= maxAgentAdmissions
```

The minimum resume-prompt calculation changes concretely, not just by rename. Today it is `minimumResumePromptChars(maxAgents) = 512 + maxAgents * 320` (`render.ts`). Because the runtime envelope of section 8 is prepended to resume prompts and counts toward `maxResumePromptChars`, the formula becomes:

```text
minimumResumePromptChars(maxAgentAdmissions) =
  512 + maxAgentAdmissions * 320 + MAX_RUNTIME_ENVELOPE_CHARS
```

`MAX_RUNTIME_ENVELOPE_CHARS` is the render module's exported fixed upper bound for the rendered envelope (its text is constant and its numbers are bounded by the digits of `limit`). Deriving the minimum from the same constant that bounds the renderer keeps this one fact in one place.

Brood is private and versioned `0.0.0`, so there should be no deprecated alias and no dual decode path. Accepting both names would preserve the conceptual ambiguity and create two sources of truth. The rename must be complete across source, tests, fixtures, examples, README text, CLI documentation, smoke configurations, status builders, and internal option names.

The legacy key must fail loudly, and the mechanism above is the **only** one that works — this was verified against the pinned `effect@4.0.0-beta.105`, not assumed. Because `maxAgentAdmissions` has a decoding default, an old config is never "missing" a field; and generic excess-key rejection is provably inert through Brood's config path: `Config.schema`'s cursor materializes only the schema's _declared_ property names before the struct parser runs, so `onExcessProperty: "error"` and whole-struct filters never even see an unknown key. Declaring `maxAgents` as an `optionalKey(Schema.Never)` tombstone makes it a declared name the cursor materializes whenever the operator's config contains it, at which point `Never` fails every value with the rename message. Verified properties: the failure carries `path: "maxAgents"` through the existing `firstIssuePath` plumbing in `runtime.ts` with no changes; and the encoded type gains `maxAgents?: never`, so programmatic callers get the rename as a compile error rather than a runtime one.

One gap is accepted deliberately rather than inherited: `ConfigProvider.fromUnknown` treats a `null` (or `undefined`) leaf as an absent key, so `{"maxAgents": null}` decodes successfully with the default limit — the provider erases the key before any schema can see it. A genuine stale config carries a number, not a null, so closing this would require a raw-input `Object.hasOwn` pre-check that is not warranted; this is recorded so the limitation is a decision, not a surprise. Note also that Schema reports the first failing property by default: a config with both a stale `maxAgents` and another invalid field may show the other field's error first. The decode still fails either way; the migration-message test fixture must therefore contain only the legacy-key error.

### 4.2 Run-instruction bound

`maxRunInstructionsChars` bounds the normalized instruction text in Unicode code points, not UTF-16 code units or bytes. The default of 4,000 code points is deliberately enough for a meaningful charter but too small for an operator to smuggle an entire project corpus into every model request.

The limit applies after newline and control-character normalization and before prompt rendering. Because the charter is XML-escaped at render time, the rendered section can exceed the configured bound by the escape expansion factor (worst case roughly 5x for text composed entirely of `&`); the bound is denominated in operator-authored code points, and the named prompt-surface total below inherits that caveat. It is configuration because installations may have materially different context budgets. It should not be profile-specific in v1.

## 5. Public run request

The run entry point should become object-shaped so the API can add run metadata without an expanding positional signature:

```ts
export const BroodRunRequestInput = Schema.Struct({
  goal: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
});

export type BroodRunRequestEncoded = typeof BroodRunRequestInput.Encoded;

export interface BroodRunRequest {
  readonly goal: string;
  readonly instructions?: string;
}
```

The public surface becomes:

```ts
export interface BroodApplication {
  readonly controller: BroodController
  readonly run: (
    request: BroodRunRequestEncoded
  ) => Effect.Effect<
    BroodResult,
    AgentFailed | RootInterrupted | RootStartError
  >
}

export const runBrood = (
  request: BroodRunRequestEncoded,
  config: BroodConfigEncoded
): Effect.Effect<
  BroodResult,
  BroodConfigError | RootStartError | AgentFailed | RootInterrupted
>
```

There should be no string overload. The project is not carrying a compatibility obligation, and two public invocation shapes would make examples, tests, and future request fields unnecessarily ambiguous.

### 5.1 Request normalization

The Schema checks structural input. A single request-normalization function then performs the semantic checks using the already decoded runtime configuration:

```ts
const normalizeRunRequest = (
  input: BroodRunRequestEncoded,
  maxRunInstructionsChars: number
): Effect.Effect<BroodRunRequest, RootStartError>
```

It must:

1. normalize line endings and the same unsafe control characters handled by Brood's existing text normalization;
2. trim the goal and reject an empty normalized goal;
3. trim instructions when present and reject an explicitly supplied empty normalized value;
4. count instruction length in Unicode code points;
5. reject instructions longer than `maxRunInstructionsChars` rather than silently truncating operator policy.

Silent truncation is inappropriate here. Result summaries are lossy projections, but run instructions express operator intent. Executing a truncated charter would be less honest than rejecting it.

`RootStartError` should expose a reason instead of forcing callers to parse its message:

```ts
export class RootStartError extends Schema.TaggedError<RootStartError>()("RootStartError", {
  reason: Schema.Literals(["InvalidGoal", "InvalidInstructions", "AlreadyStarted"]),
  message: Schema.String,
}) {}
```

`normalizeRunRequest` becomes the **only** semantic gate for run input, and the plan must say what it replaces. The existing `Goal` schema and `decodeGoal` in `agent.ts` are removed; `startRoot` accepts the already-normalized goal instead of re-validating it. `render.ts` keeps its render-time `normalizeText` call, which is idempotent on already-normalized input and stays as defense in depth — but it is not a second validation path, because it can no longer reject. After this change `RootStartError` is constructed in exactly two places: `normalizeRunRequest` (`InvalidGoal`, `InvalidInstructions`) and the registry's root-registration transition, which gains the `AlreadyStarted` reason for its existing "already admitted or closed its root" failure. `normalizeRunRequest` itself lives in `main.ts` beside the request type it validates; `render.ts` exports its existing `normalizeText` for it rather than growing a second normalizer.

The normalized request is immutable run state. Instructions cannot be edited after root admission and are not a steering channel.

### 5.2 CLI surface

The CLI keeps `--goal` and positional goal support and adds one optional source:

```text
brood --config brood.json --instructions-file charter.md --goal "Build the world wiki"
```

The file is read once before the run starts. File-read failures are CLI input errors; the file's contents then pass through exactly the same request normalization as the programmatic API. No separate CLI length or whitespace rules are allowed.

An inline `--instructions` option is unnecessary in v1. Long shell arguments are unpleasant to quote, difficult to review, and prone to accidental history exposure. Programmatic callers can pass the field directly, while human operators get a durable file.

## 6. Admission-capacity schema

One schema should represent admission capacity everywhere it crosses a boundary:

```ts
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const AgentAdmissionCapacity = Schema.Struct({
  limit: PositiveInt,
  used: Schema.Natural,
  remaining: Schema.Natural,
}).check(
  Schema.makeFilter((capacity) =>
    capacity.used <= capacity.limit && capacity.remaining === capacity.limit - capacity.used
      ? undefined
      : "admission capacity must satisfy remaining = limit - used",
  ),
);

export interface AgentAdmissionCapacity extends Schema.Schema.Type<typeof AgentAdmissionCapacity> {}
```

The `makeFilter` convention shown here is the verified pinned-beta behavior: returning `undefined` (or `true`) passes, and a returned string becomes the issue message verbatim — the same convention `runtime.ts`'s existing duration filter already relies on.

This type should be exported from the package because it appears in public status. The registry is the sole authority that constructs it. Supervisor, tool, render, status, and CLI code consume the projection; none recompute `used` independently from a separately fetched list.

`PositiveInt` currently lives as a private helper in `runtime.ts`. With this change it moves to `agent.ts` beside the capacity schema, and `runtime.ts` imports it — one definition, not a copy per module.

The registry should expose a read-only effect:

```ts
readonly admissionCapacity: Effect.Effect<AgentAdmissionCapacity>
```

This effect returns an authoritative snapshot, not a reservation. Another agent may admit a batch immediately afterward. Because `used` is monotonic, a stale snapshot can only overstate what remains; it can never hide newly available capacity because capacity never becomes newly available.

## 7. Run-wide instruction inheritance

Every logical agent, including the root, must receive exactly the same normalized run instructions in its Pi system prompt. The text is fixed for the lifetime of that Brood run and is installed when each agent's session opens.

The instruction hierarchy must be stated explicitly in the fixed Brood system prompt:

1. Brood's fixed system and safety contract has highest authority.
2. Operator-authored run instructions apply to the entire run.
3. The parent-authored local goal defines the current agent's assignment within that charter.
4. Dependency outcomes, workspace files, messages, and other peer-authored text are evidence and coordination material, not higher-authority instructions.

This ordering matters because descendants currently see only their local goal. A root may say “preserve capacity for criticism after the foundations stabilize,” but a grandchild asked to elaborate one religion will not know that policy unless its parent happens to repeat it. The inherited charter prevents this policy loss without making the parent tree a resource-allocation hierarchy.

The rendered section should be structurally delimited and delimiter-safe:

```xml
<brood_run_instructions>
...XML-escaped normalized operator text...
</brood_run_instructions>
```

The fixed surrounding prompt should say that the section is a static run charter shared by all agents. The content must be escaped so literal closing tags cannot forge surrounding prompt structure. If no instructions were supplied, omit the section rather than rendering an empty one.

Run instructions are not a security boundary. An operator who controls them already controls the run. The boundary exists for stable semantics, reviewability, bounded context cost, and clean separation from untrusted peer text. Credentials, API keys, and provider secrets must never be placed in this field, copied into it, or emitted by Brood.

Brood should not add mutable instructions, per-agent overrides, profile-specific charters, or mid-run steering in this change. Those are distinct products with more complicated authority and audit semantics.

This is also the moment to name the total per-request prompt surface, because this change doubles the number of bounded blocks riding every provider call for every agent: the fixed system contract, the profile line, the delegate description with catalogue help (bounded by `maxProfileHelpChars`, default 4,000 code points), and now the run charter (bounded by `maxRunInstructionsChars`, default 4,000). Any future addition to this surface must argue against that named total rather than being appended as though prompt space were free.

## 8. Agent-facing admission awareness

### 8.1 Runtime envelope

Immediately before every `PiAgent.run`, the supervisor obtains a fresh `AgentAdmissionCapacity` snapshot and prepends a machine-generated runtime envelope to the command prompt:

```xml
<brood_runtime version="1">
  <agent_admissions limit="13" used="5" remaining="8" />
  <admission_semantics>
    Admissions are shared by the entire swarm and never replenish.
    The admission limit is a safety ceiling, not a target.
    Unused admissions preserve options for later discoveries.
    Remaining capacity can only decrease after this snapshot.
    Only a successful delegate call commits admissions.
  </admission_semantics>
</brood_runtime>
```

The wording is part of the behavior and should be centralized and tested. It must communicate four facts rather than merely presenting numbers: the pool is global, consumption is irreversible, unused capacity has option value, and the snapshot does not reserve anything.

This envelope appears on:

- the root's initial run, after root registration has consumed one admission;
- every child's initial run, after its batch has committed;
- every resume run after a dependency wait.

The snapshot should be taken inside the run permit, immediately before command rendering and the Pi call, so time spent queued for concurrency does not unnecessarily stale it. A concurrent admission may still occur between the snapshot and the model request; that is acceptable and explicitly described by the semantics.

The runtime envelope counts toward `maxResumePromptChars`. The existing minimum-resume calculation must include the maximum fixed envelope size. Brood must not truncate the envelope independently, since that could separate the numbers from their semantics.

### 8.2 What agents should not see

The runtime envelope should not include active-run counts, concurrency permits, queued agents, the global agent roster, sibling goals, parent goals, status trees, or cost estimates.

Those data answer different questions. `maxConcurrency` is scheduler machinery; an agent should decide whether a task deserves an admission, not whether a run permit happens to be available at that instant. Active and queued counts fluctuate quickly and invite agents to optimize around scheduler noise. Global goals and status also create privacy, prompt-size, and authority problems that are not required to solve admission allocation.

The minimal agent-facing signal is therefore only `limit`, `used`, and `remaining`, plus their stable semantics.

### 8.3 Freshness within one model turn

Pi can execute several tool calls in one assistant turn. The initial runtime envelope cannot reflect admissions made later in that same turn. Successful `delegate` results therefore carry the capacity after their own commit. That gives the model a fresh observation before it chooses another tool call in a later turn, and it makes transcripts auditable.

No steering hook should be added merely to push capacity updates while the model is already generating. The capacity is monotonic, delegation remains atomically validated, and the tool result is the correct causal acknowledgement of a state-changing action.

## 9. Delegation contract

### 9.1 Atomic registry result

Successful batch registration should return the capacity produced by the same serialized registry transition:

```ts
export interface BatchRegistration {
  readonly children: ReadonlyArray<RegisteredAgent>;
  readonly capacityAfterCommit: AgentAdmissionCapacity;
}
```

The supervisor must not register a batch and then issue a separate capacity query to populate its tool result. That would allow another batch to interleave, causing the result to describe global state after unrelated work instead of the state produced by this delegation. Both are valid snapshots, but only the former is a precise acknowledgement.

For a batch of size `n`:

```text
capacityAfterCommit.used = capacityBefore.used + n
capacityAfterCommit.remaining = capacityBefore.remaining - n
```

### 9.2 Transcript-visible details

`DelegateToolDetails` becomes version 2:

```ts
const DelegatedAgent = Schema.Struct({
  name: AgentName,
  id: AgentId,
  profile: ProfileName,
});

export const DelegateToolDetails = Schema.Struct({
  version: Schema.Literal(2),
  batchId: BatchId,
  agents: Schema.Array(DelegatedAgent),
  admissions: AgentAdmissionCapacity,
  broodControl: BroodControl,
});
```

`BroodControl` remains version 1. Suspension semantics have not changed; only the containing delegate payload has gained data. `WaitToolDetails` also remains version 1 because waiting does not commit admissions.

Brood does not need to decode historical v1 delegate details from old sessions. Agent sessions are run-scoped and are not resumed across Brood process versions. A clean version bump is preferable to an unnecessary compatibility union.

The human/model-readable tool result should end with wording equivalent to:

```text
Agent admissions after this batch: 7 of 13 used; 6 remain.
Remaining admissions are shared globally and may decrease concurrently.
```

The rendered numbers and structured `details.admissions` must come from the same value.

### 9.3 Tool description

The generated `delegate` description should explain:

```text
Each task creates one logical agent and irreversibly consumes one admission from
the run-wide pool. Admissions are shared across every branch, include completed
and failed agents, and never replenish during the run. A batch is all-or-nothing.
Use the capacity shown in your runtime context and prior delegate results. The
limit is a safety ceiling, not a target; preserve slack when future work is still
uncertain. Every child receives the same delegation tools and run instructions.
```

It should not recommend a particular depth, fixed number of children, root-controlled allocation, or “one child may spawn one descendant” rule. The entire point is to let agents choose breadth and depth according to the work while bearing the global opportunity cost.

## 10. Quantitative admission rejection

An oversized batch deserves a dedicated typed error rather than a string-only `DelegateRejected` variant:

```ts
export class AgentAdmissionLimitExceeded extends Schema.TaggedError<AgentAdmissionLimitExceeded>()(
  "AgentAdmissionLimitExceeded",
  {
    requested: PositiveInt,
    capacity: AgentAdmissionCapacity,
  },
) {
  get message(): string {
    const remaining = this.capacity.remaining;
    const next =
      remaining === 0
        ? "Continue without delegation."
        : `Re-plan with at most ${remaining} task${remaining === 1 ? "" : "s"}, or continue directly.`;
    return `Requested ${this.requested} agent admissions, but only ${remaining} of ${this.capacity.limit} remain; no agents were created. ${next}`;
  }
}
```

The internal delegation error channel becomes:

```ts
type DelegateError = DelegateRejected | AgentAdmissionLimitExceeded;

interface ControlToolPort {
  readonly delegate: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    tasks: ReadonlyArray<DelegatedTask>,
    wait: "all" | "none",
  ) => Effect.Effect<DelegateToolDetails, DelegateError>;
}
```

`AgentLimitExceeded` should be removed from `DelegateRejected.reason`; all other rejection reasons stay there. The new error can remain an internal composition export unless a public API begins exposing direct delegation. It is a Schema error because it crosses the registry-to-tool boundary and its fields are transcript-relevant.

The rejection capacity must be captured by the same failed registry transition that checks the batch. The transaction commits no agent records, returns no child IDs, changes neither `used` nor `remaining`, and leaves the invocation retryable with a smaller batch. Other concurrent batches may subsequently change the global state, so a retry still requires ordinary atomic validation.

If two parents race for the last admissions, serialization decides which complete batch wins. The loser receives the capacity at its own failed transition. Partial fan-out is never allowed.

## 11. Status alignment

Operator status already exposes both cumulative agent capacity and reusable run capacity. This proposal changes its vocabulary and reuses the same admission schema:

```ts
export const SwarmStatus = Schema.Struct({
  version: Schema.Literal(1),
  state: SwarmRunState,
  elapsedMillis: NonNegativeMillis,
  capacity: Schema.Struct({
    admissions: AgentAdmissionCapacity,
    runs: Schema.Struct({
      active: Schema.Natural,
      limit: Schema.Natural,
      available: Schema.Natural,
    }),
  }),
  counts: StatusCounts,
  agents: Schema.Array(StatusAgent),
});
```

`capacity.agents.admitted` becomes `capacity.admissions.used`. The CLI formatter should say “admissions” and “active runs,” making the cumulative/reusable distinction explicit.

Because the package is private and this change is coordinated across all consumers, the schema may remain version 1 as the first actual contract. If any external consumer is discovered during implementation, bump it to version 2 instead of silently changing a published format. That is a review-time repository check, not a reason to carry both shapes.

Status remains richer than the model-facing envelope. Operators need run utilization and the agent tree for diagnosis; agents do not need scheduler telemetry to decide whether delegation is worthwhile.

## 12. State-flow semantics

The intended flow for a successful delegation is:

```text
model calls delegate(tasks)
  -> tool input and profiles validate
  -> registry serializes one batch transition
  -> registry checks requested <= remaining
  -> registry commits all child records
  -> registry returns children + capacityAfterCommit
  -> supervisor installs controllers
  -> tool result reports children + capacityAfterCommit
  -> Pi may suspend the parent after the tool batch
```

The intended flow for a rejected delegation is:

```text
model calls delegate(tasks)
  -> tool input and profiles validate
  -> registry serializes one batch transition
  -> registry finds requested > remaining
  -> registry returns AgentAdmissionLimitExceeded + current capacity
  -> no child record becomes visible
  -> invocation remains retryable
  -> parent continues and can re-plan
```

The intended flow for an agent run is:

```text
controller receives InitialGoal or Resume
  -> controller acquires one global run permit
  -> supervisor reads fresh admission capacity
  -> renderer prepends the runtime envelope to the command
  -> existing Pi session runs
  -> permit is released on completion, suspension, failure, or interruption
```

The run-wide instructions are not repeated in that command. They are installed in the session's system prompt at open time. The dynamic capacity is not installed in the system prompt because it must be refreshed between runs on the same session.

## 13. Required invariants

Implementation and tests must make the following properties explicit:

1. Root admission changes capacity from `{ used: 0, remaining: limit }` to `{ used: 1, remaining: limit - 1 }` before the root's first prompt.
2. A child batch of size `n` changes `used` by exactly `n` or not at all.
3. Terminal settlement never changes admission capacity.
4. Controller installation and Pi startup failure never refund admission.
5. Invalid input, unknown profiles, name collisions, and duplicate invocations consume nothing.
6. Successful tool details contain the exact post-commit capacity from their registration transition.
7. Limit rejection contains the exact capacity from its failed transition and commits nothing.
8. A rejected invocation can be retried; a successfully committed invocation remains idempotently non-repeatable under the existing duplicate-invocation rule.
9. Capacity shown before a Pi run comes from the registry after the agent itself has been admitted.
10. Run instructions are byte-for-byte equivalent after normalization for root, child, and grandchild system prompts.
11. A child local goal cannot replace or erase the inherited run-instruction section.
12. No provider credential, resolved `Model`, authorization header, or secret configuration enters instructions, capacity, status, events, or tool details.

No additional semaphore, counter `Ref`, or supervisor-local admission cache should be introduced. The registry already serializes the relevant state. Duplicating the counter would manufacture consistency work with no benefit.

## 14. Test plan

This change should be implemented test-first at the boundary under change. The following cases are required.

### 14.1 Configuration and request decoding

- `maxAgentAdmissions` defaults to 128.
- `maxConcurrency > maxAgentAdmissions` fails at the existing Schema boundary with the renamed path and message.
- a config containing `maxAgents` with any non-null value fails with the rename message at path `maxAgents` (fixture must contain no other invalid field, since Schema reports the first failing property);
- the accepted `maxAgents: null` provider-erasure gap is documented by a test that proves it decodes with the default, so the limitation stays visible;
- `BroodConfigEncoded` rejects `maxAgents` at compile time (a type-level test);
- the resume-prompt minimum is calculated from `maxAgentAdmissions`;
- a string goal is no longer a valid programmatic run request;
- goal whitespace and line endings normalize once; an empty normalized goal fails with `InvalidGoal`;
- absent instructions are valid and render no instruction section;
- nonempty instructions normalize and survive in full;
- explicitly empty or whitespace-only instructions fail with `InvalidInstructions`;
- exactly `maxRunInstructionsChars` Unicode code points succeeds;
- one code point over fails without truncation;
- astral Unicode characters prove that code points, not UTF-16 code units, are counted;
- delimiter text such as `</brood_run_instructions>` is visibly neutralized in the rendered system prompt.

### 14.2 Registry capacity

- a newly constructed empty registry reports `{ used: 0, remaining: limit }`;
- root registration consumes one admission;
- successful batch registration returns the correct post-commit capacity;
- completed, failed, and interrupted agents remain counted;
- failed startup remains counted;
- an oversized batch produces `AgentAdmissionLimitExceeded` with exact `requested`, `limit`, `used`, and `remaining`;
- rejected registration leaves the registry snapshot and child-name namespace unchanged;
- the rejected invocation ID can be retried with a fitting batch;
- invalid input and unknown profiles consume no admission;
- concurrent fitting batches cannot over-admit;
- two batches racing for insufficient remaining capacity result in one whole success and one whole failure, never partial children;
- capacity schema invariants reject inconsistent constructed values.

### 14.3 Prompt propagation

- the root's initial prompt reports one used admission;
- a child initial prompt reports capacity after its batch was admitted;
- a resumed parent receives a newly read capacity rather than its previous snapshot;
- root, child, and grandchild Pi open requests contain the same normalized run-instruction section;
- different local goals remain distinct while the charter remains equal;
- the fixed system prompt states the authority order;
- the runtime envelope states global, non-replenishing, non-target, and non-reservation semantics;
- runtime prompts do not expose active-run counts, queued counts, other goals, provider credentials, or the status tree;
- the runtime envelope plus the largest valid resume stays within the configured prompt budget or triggers the existing bounded-render behavior deterministically.

### 14.4 Tool protocol

- the generated delegate description contains the configured admission semantics and says every child can delegate;
- successful details decode only as `DelegateToolDetails` version 2;
- structured admissions equal the rendered admissions line;
- `wait: "all"` and `wait: "none"` preserve their existing control markers;
- `WaitToolDetails` remains version 1 and unchanged;
- a zero-remaining rejection advises continuing without delegation;
- a positive-remaining rejection reports the exact maximum fitting task count;
- rejection creates no suspension marker and allows the model to continue;
- a second delegate after a successful first batch observes the updated capacity rather than the turn's initial envelope.

### 14.5 Status and CLI

- status uses `capacity.admissions` with the shared schema;
- status run capacity remains reusable and distinct;
- compact status formatting labels admissions clearly;
- `--instructions-file` subscribes to existing runtime behavior rather than creating a second decoder;
- missing, unreadable, empty, and over-limit instruction files produce sanitized terminal errors;
- noninteractive completion/failure output remains valid NDJSON;
- README and example commands use the object-shaped API and renamed configuration.

### 14.6 Regression gates

The existing suspension, wait activation, permit release, session reuse, transcript hygiene, interruption, drain, profile resolution, monitoring, and privacy tests must remain green. The proposal does not alter the parent/child wait restriction, batch installation barrier, global run semaphore, or session lifecycle.

## 15. Falsifying experiment

The feature is incomplete until it is exercised against the allocation failure that motivated it. The experiment should isolate visibility and charter inheritance rather than repeat the quota-heavy successful prompt.

Run the worldbuilding task at least five times with:

- `maxAgentAdmissions: 13`;
- the existing global concurrency setting;
- unrestricted recursive delegation;
- no numeric per-branch quotas;
- no prescribed tree depth;
- no reserved critic slot;
- a staged goal whose later synthesis and criticism phases depend on earlier foundations;
- inherited instructions explaining that admissions are global, non-replenishing, and worth preserving while prerequisites or later discoveries remain uncertain.

The charter may describe desired reasoning, such as stabilizing prerequisites before downstream elaboration and retaining option value for integration or criticism. It must not covertly reproduce the previous topology by saying how many agents each branch may create.

For every run, record:

- admission use when the foundation phase becomes usable;
- whether each planned late phase obtains an agent;
- whether agents delegate before their stated prerequisites exist;
- total admissions, maximum depth, breadth by parent, and terminal outcomes;
- rejected batches and the agents' subsequent behavior;
- unused admissions at completion;
- obvious under-delegation where parallel independent work was available but no agent was created;
- output quality, causal integration, link validity, stub count, and critic coverage using the same review rubric across runs.

The intervention is falsified if at least two of five runs exhaust admissions before a necessary late integration or criticism phase. One failure is inconclusive and warrants a second set before changing policy. Persistent under-delegation also counts as failure: the goal is not merely to avoid exhaustion but to improve allocation without paralyzing useful fan-out.

The review rubric must be written and frozen **before** the first run and stored with the retained artifacts. Criteria adjusted after seeing outputs cannot falsify anything; pre-registration is what makes the five runs evidence rather than anecdote.

The experiment is a live, opt-in evaluation and should not enter the default unit-test suite. Its prompt, configuration, raw event stream, final status, and artifact-review results should be retained so future policy proposals can be compared against evidence rather than anecdotes.

## 16. What follows if visibility fails

The next mechanism should address the demonstrated failure mode with the least topology commitment. The leading candidate is a temporal or single-holder reservation: preserve some admissions for a named later phase or release condition, then return them to the global pool. The reservation would protect future optionality without assigning permanent budgets to ancestry branches.

That design is intentionally not specified here. It raises unresolved questions about who may reserve, how reservations expire, what happens when the holder fails, whether reserved capacity can be borrowed, and how agents observe it. It deserves a separate proposal informed by the experiment.

Subtree budgets remain a later alternative. Their strongest argument is fault containment: a branch cannot consume capacity promised elsewhere, and the commitment survives context loss. Their strongest weakness is that an ancestor's early estimate becomes binding on descendants with better local information, while unexpected high-value work may appear deep in the tree. Brood should not choose that trade-off until global visibility plus inherited policy has demonstrably failed.

A general admission-policy hook should also wait. There is currently only one concrete policy: a global cumulative limit. Designing an abstraction around hypothetical future policies would freeze accidental concepts before a second implementation provides a real comparison point.

## 17. Explicit non-goals

This proposal does not add:

- subtree, per-parent, per-depth, or per-profile admission budgets;
- a root-only allocation authority;
- reservations or phase quotas;
- delegation bidding, markets, prices, or token transfers;
- economic model-token or currency budgets;
- per-agent visibility into run-slot utilization;
- a global roster or swarm-status tool for agents;
- dynamic run-instruction changes or steering;
- profile-specific run instructions;
- admission refunds;
- automatic delegation recommendations;
- changes to waiting, suspension, drain, or orphan semantics.

Markets are particularly inappropriate at this stage. Brood has no defensible per-task utility function, price discovery process, or comparable cost estimate. A bidding interface would add ceremony and false precision while leaving the underlying allocation judgment inside language models.

True spend control is a separate future feature. Agent count is at best a rough proxy for cost because models, thinking levels, prompt lengths, tool activity, and number of turns differ. The rename to `maxAgentAdmissions` is partly intended to prevent callers from mistaking it for a monetary or token budget.

## 18. Implementation sequence

Implementation details are subordinate to the contract, but the safest order is:

1. Add failing tests for `AgentAdmissionCapacity`, rename the configuration, and centralize the registry projection.
2. Change batch registration to return atomic success or rejection capacity and introduce `AgentAdmissionLimitExceeded`.
3. Upgrade `DelegateToolDetails` and its renderer/description.
4. Add the object-shaped run request, semantic normalization, and `RootStartError.reason`.
5. Install inherited run instructions into every Pi open request.
6. Add the dynamic admission envelope before every Pi run.
7. Align status, CLI, examples, and documentation.
8. Run all static and unit gates.
9. Execute and record the five-run falsifying experiment.

The implementation should remain inside the existing module responsibilities: vocabulary and boundary schemas in `agent.ts`, bounded model-readable text in `render.ts`, serialized capacity transitions in `registry.ts`, controller timing in `supervisor.ts`, tool parameters/rendering in `tools.ts`, public composition in `main.ts`, configuration in `runtime.ts`, status projection in `status.ts`, and CLI file handling in `cli.ts`. A new policy service, capacity service, or mutable run-context module is not justified.

## 19. Review decisions required

Before implementation, reviewers should explicitly accept or reject these decisions:

1. `maxAgents` is renamed outright to `maxAgentAdmissions`, with no compatibility alias, enforced by a declared `optionalKey(Schema.Never)` tombstone field (the only mechanism the Config path supports — see 4.1), with `maxAgents: null` provider erasure accepted as a documented gap.
2. The public run API accepts `{ goal, instructions? }`, with no string overload.
3. `maxRunInstructionsChars` defaults to 4,000 Unicode code points and over-limit input fails rather than truncates.
4. Run instructions are static, identical for every agent, and subordinate only to Brood's fixed system contract.
5. Agents see only cumulative admission capacity, not active/queued scheduler telemetry or a global roster.
6. Capacity is injected before every initial/resume run and returned after every successful delegation.
7. Successful delegate details become version 2; wait and Brood-control payloads remain version 1.
8. Admission overflow becomes the dedicated `AgentAdmissionLimitExceeded` error with quantitative fields.
9. Status adopts `capacity.admissions` and the shared capacity schema.
10. No reservation, subtree budget, or generic policy hook is introduced before the falsifying experiment.

If these decisions stand, the implementation is bounded and coherent. It changes what agents know and what run-wide policy they retain; it does not decide for them how the swarm must be organized.
