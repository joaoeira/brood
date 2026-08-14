# Brood

Brood runs a swarm of AI coding agents against a single goal.

You give it one goal and one working folder. It starts one agent. That agent can
recruit more agents to split the work — and those agents can recruit more. They
work concurrently in the shared folder, wait on each other's results, and the
run ends when the root agent delivers its final answer and stragglers drain. You
watch the whole swarm live from your terminal and can interrupt any part of it.
In session mode (the TUI's default), the run instead idles after the root
finishes: the settled swarm stays revivable — message any finished agent to
bring it back, follow up with the root — until you close it.

Under the hood, each agent is a real coding agent (built on the
[Pi coding-agent SDK](https://pi.dev)) with file, edit, and shell tools — plus
Brood tools for delegation, waiting, discovery, direct communication, activity,
and a run-wide bulletin feed. Brood itself is the supervisor: it schedules the
swarm, enforces the limits, settles failures, and prevents waiting agents from
deadlocking the concurrency pool.

## What a run looks like

```sh
pnpm start -- --config ./brood.json --goal "Design and document the v2 billing model"
```

The root agent reads the goal and decides how to split it. Maybe it delegates a
researcher and a modeler, waits for both, then delegates a critic before
writing the final document into the workspace. While that happens, `status` in
the same terminal shows the live tree:

```text
RUNNING  1m 12s
Admissions 6/13 (7 remaining)  Active runs 2/4 (2 available)
States starting 0 · queued 0 · running 2 · waiting 1 · completed 2 · failed 0 · interrupted 0
Swarm
root  waiting  1m 12s  → root/pricing-model
├─ root/research  completed  38.2s
├─ root/pricing-model  running  41.0s
│  └─ root/pricing-model/spreadsheet  running  12.4s
└─ root/critic  completed  9.8s
```

Every agent has a path (`root/pricing-model/spreadsheet`), a state, and a
duration. `show root/critic` prints one agent's detail; `interrupt <path>`
stops one branch without touching the rest. When the root finishes, Brood
waits for any stragglers, then returns the root's answer plus a drain report.

## The five ideas

**Agents are peers.** Every agent — root or great-grandchild — gets the same
model tools, the same workspace, and the same ability to delegate. There is no
fixed hierarchy; the tree is just a record of who created whom.

**Waiting is free.** A parent that waits for children goes to sleep: its model
conversation pauses and its concurrency slot is released. When the children
finish, the same conversation resumes with their results injected. This is why
a swarm of 50 agents can run safely with 4 concurrent model calls and never
deadlock — waiting parents don't occupy slots.

**Everything is bounded.** `maxConcurrency` caps simultaneous model runs (slots
are reused). `maxAgentAdmissions` caps the total number of agents ever created
in one run — spent admissions never come back, even when agents finish, so a
runaway branch cannot fork-bomb the run. Every agent is shown the remaining
budget before each model call and after each delegation, and a batch that
doesn't fit is rejected whole, with the exact remaining count.

**Failure is data.** A child that fails or gets interrupted doesn't hang its
parent — the parent wakes up with a bounded failure summary alongside its
siblings' results and decides what to do next.

**The workspace is the real output.** Agents are instructed to write
substantial work into the workspace and keep their final responses short,
naming the files they produced. Brood also prepares `.brood/shared/` as an
optional, durable place for notes or artifacts that later agents and later runs
may discover. It has no prescribed layout and writing there is never mandatory.

**Coordination is explicit.** Every addressable agent has a canonical path.
Agents can discover peers, publish a short current activity, leave a passive
message, or ask a correlated question that suspends the asker until the reply
arrives. A run-wide bulletin feed is the passive, Twitter-like surface for
findings useful to an unknown set of peers. Bodies remain bounded and out of
operator status; longer material belongs in `.brood/shared/`, with its path in
the message, reply, or bulletin.

## Quick start

Requires Node ≥ 22.19 and pnpm 10.

```sh
pnpm install
pnpm build
```

1. Log in to Pi once, if you haven't already: `pi /login`. Brood uses the same
   credentials your `pi` CLI maintains (`~/.pi/agent/auth.json`) — there is
   nothing to copy per project. To give Brood project-local credentials
   instead, set `piAgentDirectory` to a directory containing an `auth.json`.
2. Drop a `brood.json` in the project the agents should work on — copy
   [`brood.example.json`](./brood.example.json) and set real provider/model
   IDs in `profiles`. That file's directory becomes the workspace; sessions
   and other state default to `~/.brood`, shared by every project and kept
   owner-only.
3. Run:

```sh
pnpm start -- --config ./brood.json --goal "Implement the feature and verify it"
```

While the run is live in a terminal, these commands work:

```text
status              compact live tree (add --json for the machine-readable record)
show <path-or-id>   one agent's detail: profile, timing, wait targets, outcome
interrupt <path-or-id>
events on|off       stream lifecycle events
```

With stdin redirected, Brood instead emits newline-delimited JSON (events plus
the terminal result), suitable for scripting. Ctrl-C interrupts the entire run
and closes every model session cleanly.

## Configuration

| Field                            | Meaning                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspacePath`                  | The shared folder all agents work in. Optional; defaults to the config file's directory.                                                             |
| `stateDirectory`                 | Brood's own state (sessions, Pi settings). Optional; defaults to `~/.brood`, shared by every project. Must stay disjoint from the workspace.         |
| `piAgentDirectory`               | Optional. Set it to give Brood project-local Pi credentials (`auth.json`/`models.json` inside it); omitted, Brood uses your global `pi /login`.      |
| `sessionDirectory`               | Optional; defaults to `<stateDirectory>/sessions`.                                                                                                   |
| `maxConcurrency`                 | Maximum simultaneous model runs. Reusable slots. Default 4.                                                                                          |
| `maxAgentAdmissions`             | Lifetime cap on agents created per run, root included. Never replenishes. Default 128.                                                               |
| `profiles`                       | Named model configurations. Each agent runs one profile for its whole life.                                                                          |
| `defaultProfile` / `rootProfile` | The root uses `rootProfile` (or the default). A delegated task without an explicit profile uses the **global default** — never its parent's profile. |
| `drainTimeout`                   | How long to wait for stragglers after the root finishes before interrupting them.                                                                    |
| `max*Chars` bounds               | Size limits for result summaries, failure messages, resume prompts, tool help, and the run charter. All counted in Unicode code points.              |

### Run instructions (the charter)

Optionally pass `--instructions-file charter.md` (or `instructions` in the
programmatic API): a short operator policy that **every** agent inherits
verbatim, subordinate only to Brood's fixed rules and above any parent-written
task. Use it for run-wide guidance like "preserve admission slack for review"
or "stabilize foundations before elaborating." It is fixed for the whole run
and bounded by `maxRunInstructionsChars`.

## Programmatic API

```ts
import { Effect } from "effect";
import { runBrood } from "brood";

const program = runBrood(
  {
    goal: "Implement the feature and verify it",
    instructions: "Preserve admission slack for integration and review.",
  },
  {
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
  },
);

const result = await Effect.runPromise(program);
// result.root  — the root agent's final summary
// result.drain — whether stragglers were interrupted at the end
```

Failures are typed: a failed root rejects with `AgentFailed`, an
operator-interrupted root with `RootInterrupted`, bad configuration with
`BroodConfigError`, and an invalid request with `RootStartError`.

For a live UI, use `makeBroodApplication` inside `Effect.scoped`: it exposes
`run` plus a narrow controller with `status`, `show`, `interrupt`, and an
`events` subscription. Agent tools and the model runtime stay private.

## Agent communication

Every agent receives the same coordination surface regardless of ancestry:

```text
list_agents       discover every nonterminal, addressable peer
set_activity      replace or clear the caller's short operator-visible status
send_message      leave passive information; it does not wake a parked peer
ask_agent         ask a correlated question and wait for its reply
read_messages     read passive messages and outstanding questions
reply_to_request  resolve one question by its request ID
post_bulletin     publish an attributed, run-wide passive post
read_bulletins    read retained posts in sequence order
```

`ask_agent` is deliberately stronger than `send_message`: it wakes a parked
recipient and prevents the asker from returning to ordinary work until the
request settles. A recipient already running is notified only when its current
model turn ends; Brood does not inject tokens into an in-flight provider call.
Passive messages and bulletins never create work by themselves and may remain
unread when an agent terminates. Communication targets use canonical paths such
as `root/api/audit`, never raw UUIDs.

**Finished agents are dormant, not gone.** Passive mail to a completed or
interrupted agent queues in its inbox; an urgent message, a question, or an
operator message _revives_ it — a fresh controller reopens the agent's own
session from disk, so it returns with its full working context and answers
from what it actually did. Revived agents are full citizens (they can even
delegate, under the same never-replenishing admission budget), second
completions are latest-wins, and parents who already consumed a result are
never re-notified. Only failed agents stay beyond reach, and nothing can be
revived once the run starts draining. The design record is
[docs/proposals/revival.md](./docs/proposals/revival.md).

The bulletin feed is run-scoped and retention is bounded. `.brood/shared/` is
the cross-run mechanism: agents may organize it however the work demands, and
may point peers to a file simply by including its path in ordinary text. There
is no attachment field or required per-agent journal.

## What Brood deliberately does not do (v1)

- No crash recovery: a killed process does not resume its swarm (transcripts
  survive for auditing).
- No token-level steering: a question accepted during a provider call is
  reconciled at that turn's boundary. The run charter remains fixed at start.
- No file locking or merge protocol in the workspace: agents are instructed to
  preserve concurrent work, not prevented from colliding.
- No spend accounting: agent count is the only budget; tokens and cost are not
  metered. Profiles are routing, not authorization — any agent may use any
  configured profile.
- No cascading cancellation: a failed parent's children keep running to
  completion and are collected during drain.

These are documented decisions, not gaps discovered later — see the design
records below.

## Development

```sh
pnpm check   # typecheck + format + lint
pnpm test    # deterministic offline suite (no provider calls)
pnpm build
```

The default test suite is fully offline and deterministic. Set
`BROOD_LIVE_CONFIG=/absolute/path/to/brood.json` and run `pnpm test:live` for
the opt-in provider smoke test.

### Where things live

The module graph is organized as a bottom-up DAG; vocabulary and control modules
sit below stateful services. Tests mirror `src/` one file to one file.

| Module                       | Role                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `src/agent.ts`               | Leaf vocabulary: identifiers, outcomes, lifecycle, and errors.              |
| `src/communication.ts`       | Peer paths, messages, requests, bulletins, activity, and typed errors.      |
| `src/control.ts`             | Turn commands and exact transcript suspension markers.                      |
| `src/profiles.ts`            | Model-profile schemas and one-time catalogue compilation.                   |
| `src/render.ts`              | Everything a model reads: normalization, truncation, and prompt envelopes.  |
| `src/status.ts`              | Bounded status/detail projections and the human renderers.                  |
| `src/registry.ts`            | Serialized admission, communication, waits, settlement, and shutdown state. |
| `src/pi-adapter.ts`          | Pi sessions, prompt bridge, transcript inspection, and suspension hook.     |
| `src/tools.ts`               | The `delegate` and `wait_for_agents` control tools.                         |
| `src/communication-tools.ts` | The eight caller-bound peer-coordination tools.                             |
| `src/supervisor.ts`          | Scheduling, session controllers, run permits, drain, and monitoring.        |
| `src/runtime.ts`             | Config validation, shared-directory preparation, and wiring.                |
| `src/main.ts`                | Programmatic entry point.                                                   |
| `src/cli.ts`                 | Thin operator shell.                                                        |

Architecture, protocol invariants, and the full test contract are documented in
[`plan.md`](./plan.md); pinned Pi observations are in
[`docs/phase-0-pi-compatibility.md`](./docs/phase-0-pi-compatibility.md).
Design records for shipped and pending changes live under
[`docs/proposals/`](./docs/proposals/), most recently
[revival — terminal agents are dormant, not gone](./docs/proposals/revival.md)
(implemented).
