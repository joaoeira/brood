# Brood contributor instructions

Read `vendor/kitlangton-effect-skill/SKILL.md` before writing or reviewing Effect
code. It is the local default for Effect style; the exact pinned package source
and compiler types win when the guide differs.

Local corrections and constraints:

- This project uses Effect v4. Use `Schema.TaggedError`, not the guide's stale
  `Schema.TaggedErrorClass` examples.
- Use Schema at configuration, tool, disk, and public boundaries. Keep queues,
  deferreds, fibers, and Pi runtime objects out of Schema-defined records.
- Keep expected failures visible in the Effect error channel. Do not catch
  interruption as an ordinary error.
- Write deterministic tests with Effect synchronization primitives and
  `TestClock`; do not coordinate races with sleeps.
- Follow red-green-refactor for implementation work and run `pnpm typecheck`,
  `pnpm test`, and `pnpm check` before committing.
- Do not add `defineBroodConfig` or another configuration-validation path. Raw
  file, environment, and programmatic input all pass through the one Schema
  decode and catalogue compiler described in `plan.md`.
