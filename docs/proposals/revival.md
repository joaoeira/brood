# Revival: terminal agents are dormant, not gone

Status: implemented.

## The problem

Before this change, "terminal" was absorbing. A completed agent could never be
reached again: mail to it bounced with `RecipientTerminal`, questions failed,
and the knowledge in its session — often the freshest context anywhere about
the thing it just built — was locked behind a closed conversation. Worse, when
the root finished, the whole run ended; the operator could not ask a follow-up
without starting a new swarm from zero.

## The reframe

Completion becomes the deepest form of parked. An agent that finished still
has its identity in the registry (entries are never pruned) and its whole
conversation on disk (Pi session files are append-only JSONL, and the SDK's
`SessionManager.open` resumes one in place). Revival closes the loop: bring
the agent back onto its own session, at the next lifecycle generation, and let
the ordinary wake machinery deliver whatever needed it.

## Decisions (each deliberate, none accidental)

1. **In-process only.** Revival assumes the Brood process is alive: the
   registry, permits, and provenance exist only in memory. Post-exit resume of
   a _settled_ swarm would need only a small manifest (tree, outcomes, session
   paths) plus this same reopen machinery — deliberately kept cheap for later,
   deliberately not built now.
2. **The wake contract extends to the grave.** Passive `send_message` never
   wakes anyone, living or dead — mail to a finished agent is accepted and
   queued unread, readable if the agent ever returns. `urgent: true`,
   `ask_agent`, and operator messages — the three signals that wake a parked
   agent — revive a finished one. One mental model, no special cases.
3. **Failed agents stay dead.** Their failure summary was already delivered
   and acted on, and their session state is the least trustworthy. Passive
   mail still queues to them (nothing accepted is ever silently dropped).
4. **Interrupted agents are revivable, with transcript repair.** An abort
   mid-tool-batch leaves tool calls without results in the session file, and
   Pi has no repair path — replaying that transcript verbatim is a provider
   error. Before reopening, Brood appends synthetic aborted tool results,
   chained onto the entry tree exactly as Pi would write them. An agent
   interrupted during its _initial_ turn gets its goal reinstated at
   settlement, so a revival can re-issue work the model may never have seen.
5. **No revival budget.** Admissions count agents created, ever; a created
   agent can be revived at will, free. The accepted risk is an unbounded
   urgent-revive loop; the brakes are the operator's eyes, `interrupt`, and
   the gate below. This is a documented decision, not an oversight.
6. **Second completions are latest-wins; waits are one-shot.** A parent that
   consumed a child's result is never re-notified. The registry keeps the
   latest outcome (plus `lastCompletedResult`, never erased); the one-shot
   completion deferred keeps what its original waiters actually consumed.
   Follow-up results travel on honest channels: the ask's reply if you asked,
   otherwise messages and bulletins. A _new_ `wait_for_agents` on a currently
   revived child waits for its next completion.
7. **Revived agents are full citizens.** Same tools, same charter, including
   `delegate` — bounded by the same never-replenishing admissions. The
   registry no longer closes admissions at quiescence: a fully settled swarm
   is dormant, not finished.
8. **Session mode (opt-in).** `run(request, { session: true })` does not end
   when the root completes; the swarm idles settled until `controller.close`.
   Close shuts the revival gate, drains, and resolves with the root's latest
   _completed_ result — a close-time interruption never erases delivered
   work; the drain report records it. The CLI and the plain programmatic call
   keep the classic contract unchanged.
9. **The shutdown gate.** `closeRevivals` runs before anything waits on
   quiescence (drain start, shutdown). A run that is winding down never
   fights a resurrection; in classic mode the root's completion closes the
   gate almost immediately, so peer revival of the root effectively exists
   only in session mode.

## Mechanics

- **Registry.** `reviveEntry` flips a terminal entry back to `Queued` on the
  same entry: outcome cleared, `revivals` generation incremented,
  `revivedPending` set so the next `beginRun` stamps the command with
  `revival: "completed" | "interrupted"`. The reviving transaction inserts
  its own waking signal (urgent message, request, or operator message), so
  the standard trigger computation produces the first command. Settlement now
  retains passive mail and the goal of an interrupted initial turn.
- **Generation fence.** A controller records its spawn-time generation and
  passes it to its teardown settle. A stale backstop settle from a fiber that
  died just as its agent was revived is a no-op instead of a kill.
- **Supervisor.** The comms taps run commit + controller spawn in one
  uninterruptible region: a revival that committed without its controller
  would idle forever and hang the drain. The fresh controller opens the
  agent's session directory, finds the existing JSONL, repairs it if needed,
  and resumes it via `SessionManager.open`; a first open finds nothing and
  creates as before. `AgentRevived` events carry the new generation.
- **Prompts.** The first command after revival opens with a fixed
  `<brood_revival>` preamble — you finished (or were interrupted), your
  delivered result stands, something below needs you — reserved whole in the
  resume budget like the operator envelope.

## What this deliberately does not change

- No crash recovery: a killed process still does not resume its swarm.
- No re-notification channel for parents; no versioned outcome history
  beyond the transcript.
- No cascading revival: reviving a parent does not revive its children.
- The run charter remains fixed for the run's lifetime, revivals included.
