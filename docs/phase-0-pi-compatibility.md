# Phase 0 Pi compatibility record

Date: 2026-08-07

## Resolved package provenance

Brood pins these Pi packages at `0.84.1`:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`

The npm metadata for all three packages records this source commit:

```text
53fa77ccd8a279eb87e92294ef3687b03ff80112
```

The planning review originally cited the later commit
`958c13f25080b59d4b736193f972a8502a7a2f8b`. A direct Git tree comparison found
no differences between the published commit and that later commit in any
load-bearing file inspected:

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/model-runtime.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/ai/src/models.ts`
- `packages/ai/src/types.ts`

The differences between those commits are confined to changelogs, tests, and
the newer agent-harness session implementation. They do not change the legacy
agent loop or coding-agent SDK surfaces Brood v1 uses. Primary source links in
`plan.md` therefore point to the exact published commit.

For reproducibility, the pinned coding-agent tarball has npm integrity
`sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==`.

## Verified SDK surface

`test/pi-sdk-compatibility.test.ts` compiles and runs offline against the
published packages. It verifies the exact surfaces Brood plans to wrap:

- exact `ModelRuntime.getModel(provider, model)` lookup;
- `createAgentSession` with an explicit model and clamped thinking level;
- custom TypeBox tools and runtime-valued `StringEnum` schemas;
- `SettingsManager.inMemory`, `DefaultResourceLoader`, and
  `SessionManager.inMemory` construction;
- assignment of `session.agent.shouldStopAfterTurn`;
- session abort and synchronous dispose;
- Pi's exported `ModelThinkingLevel` and Brood's two-way compile-time drift
  guard for the runtime literal tuple.

The exact exported type is `ModelThinkingLevel` from
`@earendil-works/pi-ai`. Its pinned values are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`.

Pi builds with TypeScript `5.9.3`, `@types/node` `24.12.4`, and
`skipLibCheck: true`. Brood aligns with those compiler versions. The published
provider declarations are not independently clean under `skipLibCheck: false`
(notably JSON declaration imports and optional provider type dependencies), so
Brood also skips checking dependency declarations while keeping strict checking
for every included Brood and test source file.

## Tool-call identity finding

The pinned loop executes every tool call present in each completed assistant
message. It appends the resulting tool-result messages before invoking
`shouldStopAfterTurn`. Provider retry and overflow recovery remove failed or
truncated assistant messages before continuing; they do not replay an already
executed successful tool batch.

However, Pi does not maintain a session-wide set of tool-call IDs. An executable
characterization test emits `toolCallId = "reused-id"` in two successive
assistant turns and observes two calls to the custom tool's `execute`. This is a
reachable provider-boundary event even though well-behaved providers normally
generate unique IDs.

Brood therefore needs only a guard for duplicate Brood invocation IDs within
the currently claimed command. Each successful state-changing tool records its
ID in the same registry transition as its mutation; `finishTurn` clears that
command-local map. Cross-tool reuse in the same assistant run returns a typed,
model-visible error and performs no mutation. Reuse in a later run is allowed
because Pi itself gives the same ID no session-wide identity. Brood does not
need a result cache, argument fingerprint, or generic Pi-tool replay framework
in v1.

## Turn-finalization and suspension findings

The pinned `agent-loop` executes all tool calls in one assistant message before
consulting `shouldStopAfterTurn`. It appends each finalized `ToolResultMessage`
to both the current context and the run's `newMessages`, then emits `turn_end`,
and only then awaits the stop hook. `AgentSession` handles each `message_end`
event by synchronously appending the message to its `SessionManager` before the
loop reaches the hook. A characterization test observes the same successful
tool details in the hook's `toolResults`, the loop context, `session.messages`,
and the JSONL session file. Brood can therefore stop after a control result
without leaving a dangling tool call or losing its machine-readable marker.

Ordinary non-sequential tools execute concurrently. Their completion events may
be out of order, but Pi awaits the callback promises with `Promise.all` over the
assistant's original tool-call array and emits the finalized result messages in
that array order. The compatibility test deliberately completes the second tool
before the first and still observes `first-call`, then `second-call`. Brood's v1
control tools are sequential, but the adapter preserves this upstream source
order when it constructs its complete suspension-marker tuple.

The hook receives one successful marker for each accepted control operation.
Brood decodes successful `delegate`, `wait_for_agents`, and `ask_agent` details
strictly, checks that the embedded invocation ID equals Pi's tool-call ID, and
derives the closed marker variant from the tool name. `ask_agent` additionally
supplies the decoded request ID. Missing fields, excess fields, invalid request
IDs, invocation mismatches, an impossible successful `ask_agent` continuation,
and incomplete or reordered call/result batches become `PiProtocolError`.
Failed known tools and unrelated tools contribute no marker. A suspended run is
valid only when the marked assistant message is also the final `toolUse` turn.

## Failed tool callbacks

Pi catches values thrown by a tool callback. If the value is an `Error`, Pi
uses its `message`; otherwise it uses `String(value)`. It constructs an error
tool result with exactly one text item, empty details, and `isError: true`.
The compatibility test throws an Effect `Schema.TaggedError` and verifies that
the complete actionable sentence survives while typed fields do not. Brood
must consequently put every model-actionable explanation in the error's
`message`; rejected callbacks cannot carry a suspension marker in `details`.

## Steering, preparation, and prompt settlement

The core loop polls steering once at loop startup. After a tool turn it invokes
`prepareNextTurn`, then `shouldStopAfterTurn`, and polls steering again only if
the stop hook returns false. A characterization test proves that a stopping tool
turn performs exactly the initial poll and no post-hook poll. Pi exposes queues
and preparation hooks, but Brood v1 does not use them for coordination: the
adapter removes the session-installed `prepareNextTurn` hooks and installs only
`shouldStopAfterTurn`. It does not add a steering producer, preparation loop, or
detached promise. Later communication is delivered as a new controller-owned
prompt after the prior high-level prompt has settled.

`AgentSession.prompt()` wraps the core loop with retry, compaction, queue, and
`agent_settled` handling. In particular, threshold compaction can run after the
core loop's `agent_end` and before the high-level prompt promise resolves. The
global Brood run permit must therefore cover the complete `session.prompt()`
promise, not merely the core stop hook. The adapter classifies the run only
after that promise settles and captures a fresh classifier for each invocation.

## Exact active-tool invariant

Pi's default writable coding surface is produced by `createCodingTools(cwd)`;
the pinned version returns `read`, `bash`, `edit`, and `write`. Brood derives its
expected active names from that factory plus every name in `PiOpenRequest.tools`
instead of hard-coding the current Brood tool catalogue. Duplicate custom names,
or a custom name colliding with a built-in, fail session opening before Pi or the
filesystem is touched. After creation, the adapter still compares the complete
active set against that derived expectation and treats divergence as an
invariant defect.
