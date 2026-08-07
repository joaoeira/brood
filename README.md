# Brood

Brood is a small, Effect-first multi-agent harness around the Pi coding-agent SDK. A logical agent owns one persistent Pi session and a controller fiber. Only an active model run consumes a slot from the run-wide semaphore, so a parent that waits for children releases its permit and cannot deadlock the swarm.

This repository is an early v1 implementation. Its public entry point is programmatic; the CLI is a thin local operator surface, not a daemon or network API.

## Code map

The module graph is a DAG rooted in three vocabulary files; every other module imports only downward.

| Module              | Role                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/agent.ts`      | Shared vocabulary: identifiers, agent outcomes, the control protocol, every error. Imports nothing from `src/`.         |
| `src/profiles.ts`   | Model-profile config schemas and the one-time catalogue compilation to resolved Pi models.                              |
| `src/render.ts`     | Everything a model reads: normalization, code-point truncation, the resume envelope.                                    |
| `src/registry.ts`   | The serialized state machine: admission, waits, the command mailbox, terminal settlement, shutdown.                     |
| `src/pi-adapter.ts` | The only module that talks to Pi: session lifecycle, the prompt bridge, settlement classification, the suspension hook. |
| `src/tools.ts`      | The `delegate` / `wait_for_agents` tools: TypeBox schemas, input normalization, the injected supervisor port.           |
| `src/supervisor.ts` | Scheduling: the global semaphore, controller fibers, drain/interrupt, monitoring. Owns the registry privately.          |
| `src/runtime.ts`    | Config decode/validation and live Layer wiring. All config failures are `BroodConfigError`.                             |
| `src/main.ts`       | Programmatic entry: composes the application, interprets the root outcome.                                              |
| `src/cli.ts`        | Thin operator shell over `main.ts`.                                                                                     |

Tests mirror `src/` one file to one file, plus `integration.test.ts`, `pi-sdk-compatibility.test.ts` (the Phase 0 pin-guard), and deterministic fakes under `test/support/`.

## Install and build

Brood requires Node 22.19 or newer and pnpm 10. The state, Pi-agent, and session directories are forced to owner-only mode (`0700`) on startup because they contain credentials and transcripts.

```sh
pnpm install
pnpm build
```

## Configure

Copy [`brood.example.json`](./brood.example.json) and adjust the paths and exact Pi model IDs. `workspacePath` and `stateDirectory` must be disjoint. The Pi agent directory supplies `auth.json` and optional `models.json`; sessions are persisted separately under `sessionDirectory`.

Model profiles are fixed for one run. The root uses `rootProfile` when present, otherwise `defaultProfile`; every delegated task without an explicit profile uses the global default, not its parent's profile. Profile descriptions are shown to agents in the `delegate` tool, while credentials and raw Pi model configuration are not.

## Run

```sh
pnpm build
pnpm start -- --config ./brood.json --goal "Implement the feature and verify it"
```

When stdin is a terminal, Brood accepts these commands while the run is live:

```text
status
interrupt <agent-id>
events on
events off
```

With redirected stdin, monitoring and the terminal result are written as newline-delimited JSON. Pass `--events` to show events immediately in an interactive terminal. Ctrl-C interrupts the whole scoped run and closes active sessions.

## Programmatic API

```ts
import { Effect } from "effect";
import { runBrood } from "brood";

const program = runBrood("Implement the feature and verify it", {
  workspacePath: "/absolute/path/to/workspace",
  stateDirectory: "/absolute/path/to/brood-state",
  piAgentDirectory: "/absolute/path/to/brood-state/pi-agent",
  sessionDirectory: "/absolute/path/to/brood-state/sessions",
  maxConcurrency: 4,
  defaultProfile: "worker",
  rootProfile: "coordinator",
  profiles: {
    coordinator: {
      description: "Plans, delegates, and synthesizes",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    },
    worker: {
      description: "General implementation work",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    },
  },
});

const result = await Effect.runPromise(program);
```

For a live UI or operator, use `makeBroodApplication` inside `Effect.scoped`. It exposes only `run` and a narrow controller with `snapshot`, `events`, and `interrupt`; the supervisor's agent tools and Pi runtime remain private.

## Agent protocol

Agents create one or many children atomically with `delegate({ tasks, wait })`. `wait` defaults to `all`; `none` is explicit fire-and-forget. `wait_for_agents` waits for named direct children created in an earlier turn. Names are unique for a parent's lifetime, admission is bounded by `maxAgents`, and one invalid task rejects the whole batch.

Suspension happens at the end of the current assistant turn after Pi has persisted every tool result. A waiting controller releases its global run permit. When all dependencies settle, the same Pi session resumes with a bounded, delimiter-neutralized outcome envelope. Child failures and interruptions are data, so a parent never hangs waiting for a failed child.

All agents share one workspace. Brood deliberately provides no worktrees, file ownership, or merge protocol; agents are instructed to preserve concurrent work and use durable files for larger artifacts.

## V1 limits

Brood does not recover a live swarm after process failure, steer a model mid-run, enforce a depth or monetary budget, isolate the shared workspace, restrict profiles by role, switch models within a session, or cancel descendants when a parent fails. It also disables Pi's mutable workspace context-file loading; repository-specific instructions should be part of the root goal until Brood can snapshot them once at run start. The provenance tree and dynamic wait relationship are intentionally separate; orphaned agents run to completion and are included in drain.

Configured profiles have equal tools and delegation power. `maxAgents` is a total admission budget for the run, including terminal agents, while `maxConcurrency` limits only simultaneous Pi runs. Monitoring is bounded and lossy; snapshots are authoritative and Pi JSONL is the transcript audit source.

## Development

```sh
pnpm typecheck
pnpm test
pnpm check
pnpm build
```

The default suite is deterministic and offline. Set `BROOD_LIVE_CONFIG=/absolute/path/to/brood.json` and run `pnpm test:live` for the opt-in provider smoke test. Architecture, protocol invariants, test cases, and implementation order are documented in [`plan.md`](./plan.md); pinned Pi observations are in [`docs/phase-0-pi-compatibility.md`](./docs/phase-0-pi-compatibility.md).
