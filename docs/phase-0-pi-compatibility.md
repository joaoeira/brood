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

Brood therefore needs only a per-agent duplicate-control-invocation guard. The
first successful `delegate` or `wait_for_agents` invocation records its ID in
the same registry transition as its mutation. Reuse of that ID returns a typed,
model-visible tool error and performs no mutation. Brood does not need a result
cache, argument fingerprint, or generic Pi-tool replay framework in v1.
