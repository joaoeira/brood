/**
 * The real bridge: one Brood application built inside a manually-held scope
 * that lives as long as the TUI does.
 *
 * Two things matter here. First, the event subscription is opened at build time
 * rather than when the run starts, so nothing that happens in the first
 * milliseconds of a swarm is missed. Second, status refreshes are coalesced —
 * a burst of twenty events must not turn into twenty status projections — and
 * every effect runs with logging silenced, because Brood's logger and the
 * renderer both want stdout.
 */
import { Cause, Effect, Exit, Option, References, Scope, Stream } from "effect";
import type { BroodApplication, BroodResult, SupervisorEvent } from "../brood";
import { makeBroodApplicationFromUnknown } from "../brood";
import { store } from "../store";
import { tildify } from "../theme";
import { makeFileTranscriptReader } from "../transcript/watch";
import type { BridgeHandle, ConfigSummary } from "./types";

const STATUS_DEBOUNCE_MILLIS = 150;

/** Brood logs to the console; the renderer owns the console. One of them has to yield. */
const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  process.env["BROOD_TUI_LOG"] === undefined
    ? Effect.provideService(effect, References.MinimumLogLevel, "None")
    : effect;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface LiveBridgeOptions {
  readonly rawConfig: unknown;
  /** Anchors relative and defaulted config paths: the config file's directory. */
  readonly baseDir: string;
  readonly configSummary: ConfigSummary;
}

export const createLiveBridge = async (options: LiveBridgeOptions): Promise<BridgeHandle> => {
  const scope = Scope.makeUnsafe();
  const inScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
    Effect.runPromise(quiet(Effect.provideService(effect, Scope.Scope, scope)));

  const application: BroodApplication = await inScope(
    makeBroodApplicationFromUnknown(options.rawConfig, options.baseDir),
  );
  const subscription = await inScope(application.controller.events);

  // The launch screen shows what the run will actually use, not what the raw
  // config happened to spell out — defaults included.
  const resolved = application.resolved;
  const configSummary: ConfigSummary = {
    ...options.configSummary,
    workspacePath: resolved.workspacePath,
    sessionDirectory: resolved.sessionDirectory,
    authLabel:
      resolved.piAuth.kind === "pi-global"
        ? `pi login · ${tildify(resolved.piAuth.authPath)}`
        : `project · ${tildify(resolved.piAuth.authPath)}`,
  };

  let statusInFlight = false;
  let statusPending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshStatus = async (): Promise<void> => {
    if (statusInFlight) {
      statusPending = true;
      return;
    }
    statusInFlight = true;
    try {
      store.setStatus(await Effect.runPromise(quiet(application.controller.status)));
    } catch (cause: unknown) {
      store.note(`status unavailable: ${messageOf(cause)}`, "warn");
    } finally {
      statusInFlight = false;
    }
    if (statusPending) {
      statusPending = false;
      await refreshStatus();
    }
  };

  const scheduleStatusRefresh = (): void => {
    if (debounceTimer !== undefined) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refreshStatus();
    }, STATUS_DEBOUNCE_MILLIS);
  };

  const fetchBulletins = async (): Promise<void> => {
    try {
      store.setBulletins(await Effect.runPromise(quiet(application.controller.bulletins)));
    } catch (cause: unknown) {
      store.note(`bulletins unavailable: ${messageOf(cause)}`, "warn");
    }
  };

  Effect.runFork(
    Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event: SupervisorEvent) =>
        Effect.sync(() => {
          store.onEvent(event);
          scheduleStatusRefresh();
          // Keep the board current so the hint-bar unseen marker moves without
          // the operator having to open the overlay first.
          if (event.source === "supervisor" && event.type === "BulletinPosted") {
            void fetchBulletins();
          }
        }),
      ),
    ),
  );

  let runPromise: Promise<void> | undefined;
  let runSettled = false;

  /**
   * A failed start is an authoring problem, not a swarm outcome — the operator
   * should land back on the composer with the reason, not on an empty monitor.
   */
  const reportFailure = (exit: Exit.Exit<BroodResult, unknown>): void => {
    if (Exit.isSuccess(exit)) {
      store.setRunOutcome({ kind: "completed", text: exit.value.root.summary });
      return;
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      store.setRunOutcome({ kind: "interrupted", text: "the run was interrupted" });
      return;
    }
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    const tag =
      typeof error === "object" && error !== null && "_tag" in error
        ? String((error as { _tag: unknown })._tag)
        : undefined;

    if (tag === "RootStartError") {
      store.setLaunchError(messageOf(error));
      store.setPhase("launch");
      // The registry never admitted a root, so the operator may fix the goal
      // and launch again; clear the guard that would swallow the next start().
      runPromise = undefined;
      runSettled = false;
      return;
    }
    if (tag === "AgentFailed") {
      const failure = (error as { failure?: { code?: string; message?: string } }).failure;
      store.setRunOutcome({
        kind: "failed",
        text: `${failure?.code ?? "AgentFailed"} — ${failure?.message ?? ""}`,
      });
      return;
    }
    if (tag === "RootInterrupted") {
      const reason = (error as { reason?: { _tag?: string } }).reason;
      store.setRunOutcome({ kind: "interrupted", text: reason?._tag ?? "interrupted" });
      return;
    }
    store.setRunOutcome({ kind: "failed", text: messageOf(error ?? exit.cause) });
  };

  return {
    mode: "live",
    configSummary,
    transcript: makeFileTranscriptReader(resolved.sessionDirectory),

    start: (goal, instructions) => {
      if (runPromise !== undefined) return;
      store.note(`run started — ${goal}`, "info");
      const request = instructions === undefined ? { goal } : { goal, instructions };
      // Session mode: the root finishing settles the swarm rather than ending
      // the run, so the operator can still message — and so revive — agents
      // until they close the session themselves.
      runPromise = Effect.runPromiseExit(quiet(application.run(request, { session: true })))
        .then((exit) => {
          runSettled = true;
          reportFailure(exit);
        })
        .catch((cause: unknown) => {
          runSettled = true;
          store.setRunOutcome({ kind: "failed", text: messageOf(cause) });
        })
        .finally(() => {
          void refreshStatus();
        });
      void refreshStatus();
    },

    refreshStatus,

    fetchDetail: async (reference) => {
      try {
        store.setDetail(await Effect.runPromise(quiet(application.controller.show(reference))));
      } catch {
        // The tree can hold a path for an agent the registry has already
        // forgotten; an empty pane is the honest answer, not an error banner.
        store.setDetail(undefined);
      }
    },

    fetchBulletins,

    fetchTraffic: async () => {
      try {
        store.setTraffic(await Effect.runPromise(quiet(application.controller.traffic)));
      } catch (cause: unknown) {
        store.note(`traffic unavailable: ${messageOf(cause)}`, "warn");
      }
    },

    sendOperatorMessage: async (reference, body) => {
      try {
        const delivery = await Effect.runPromise(
          quiet(application.controller.sendOperatorMessage(reference, body)),
        );
        store.note(`operator → ${delivery.to}  message delivered`, "info");
        return undefined;
      } catch (cause: unknown) {
        return messageOf(cause);
      }
    },

    interrupt: async (reference) => {
      try {
        await Effect.runPromise(quiet(application.controller.interrupt(reference, "api")));
      } catch (cause: unknown) {
        store.note(`interrupt failed: ${messageOf(cause)}`, "error");
      }
    },

    close: async () => {
      if (runPromise === undefined) return;
      if (!runSettled) {
        try {
          // A root still working is stopped rather than waited out: the drain
          // that follows the close would otherwise sit on its full timeout.
          // Settled roots already hold an outcome, so this is a no-op for them.
          await Effect.runPromise(quiet(application.controller.interrupt("root", "api")));
        } catch {
          // An unknown root is not a reason to skip the close below.
        }
        await Effect.runPromise(quiet(application.controller.close));
      }
      await runPromise;
    },

    dispose: async () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
};
