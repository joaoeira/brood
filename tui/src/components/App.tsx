/**
 * Phase and overlay routing, and the one keyboard handler that owns navigation.
 *
 * Scroll keys inside the transcript and bulletin overlays are handled by those
 * components instead — they are only mounted while their overlay is open, so
 * there is nothing to arbitrate, and it keeps their scroll state where it is
 * clamped. This handler deliberately falls through to nothing while an overlay
 * is up, apart from the key that closes it.
 */
import { readFile } from "node:fs/promises";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { BridgeHandle } from "../bridge/types";
import { flattenAgents, store, useAppState } from "../store";
import { theme } from "../theme";
import { BulletinOverlay } from "./BulletinOverlay";
import { CommsScreen } from "./CommsScreen";
import { ComposeOverlay } from "./ComposeOverlay";
import { ConfirmDialog } from "./ConfirmDialog";
import { LaunchScreen, type LaunchField } from "./LaunchScreen";
import { MonitorScreen } from "./MonitorScreen";
import { TranscriptView } from "./TranscriptView";

const STATUS_POLL_MILLIS = 1_000;

export interface AppProps {
  readonly bridge: BridgeHandle;
}

export const App = ({ bridge }: AppProps) => {
  const state = useAppState();
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();
  const [field, setField] = useState<LaunchField>("goal");

  const rows = useMemo(() => flattenAgents(state.status?.agents ?? []), [state.status]);
  const { overlay, phase, selection } = state;

  useEffect(() => {
    if (phase !== "monitor") return;
    const timer = setInterval(() => void bridge.refreshStatus(), STATUS_POLL_MILLIS);
    return () => clearInterval(timer);
  }, [bridge, phase]);

  useEffect(() => {
    if (overlay !== "comms") return;
    const timer = setInterval(() => void bridge.fetchTraffic(), STATUS_POLL_MILLIS);
    return () => clearInterval(timer);
  }, [bridge, overlay]);

  // Keep a selection pinned to something that still exists: the first agent on
  // arrival, and the root again if the selected path disappears from the tree.
  useEffect(() => {
    if (rows.length === 0) return;
    const first = rows[0];
    if (first === undefined) return;
    if (selection !== undefined && rows.some((row) => row.agent.path === selection)) return;
    store.setSelection(first.agent.path);
  }, [rows, selection]);

  useEffect(() => {
    if (selection === undefined) return;
    void bridge.fetchDetail(selection);
  }, [bridge, selection, state.status]);

  // Having the board on screen is what counts as reading it; this also absorbs
  // posts that arrive while the overlay is open.
  useEffect(() => {
    if (overlay === "bulletins") store.markBulletinsSeen();
  }, [overlay, state.bulletins]);

  const exitCleanly = useCallback(async (): Promise<void> => {
    await bridge.dispose();
    renderer.destroy();
    setTimeout(() => process.exit(0), 0);
  }, [bridge, renderer]);

  const launch = useCallback(async (): Promise<void> => {
    const snapshot = store.getSnapshot();
    const goal = snapshot.goalDraft.trim();
    if (goal === "") {
      store.setLaunchError("Goal must not be empty");
      return;
    }
    const charterPath = snapshot.instructionsPath.trim();
    let instructions: string | undefined;
    if (charterPath !== "") {
      try {
        instructions = await readFile(charterPath, "utf8");
      } catch {
        // A missing or unreadable charter is treated as absent: the goal alone
        // is a valid run, and failing here would strand a ready operator.
        instructions = undefined;
      }
    }
    store.setPhase("monitor");
    bridge.start(goal, instructions);
  }, [bridge]);

  const moveSelection = useCallback(
    (delta: number): void => {
      if (rows.length === 0) return;
      const current = rows.findIndex((row) => row.agent.path === selection);
      const next = Math.max(0, Math.min(rows.length - 1, (current === -1 ? 0 : current) + delta));
      const row = rows[next];
      if (row !== undefined) store.setSelection(row.agent.path);
    },
    [rows, selection],
  );

  const confirm = useCallback(async (): Promise<void> => {
    if (typeof overlay !== "object") return;
    if (overlay.kind === "confirm-interrupt") {
      store.setOverlay("none");
      if (selection !== undefined) await bridge.interrupt(selection);
      return;
    }
    // Closing is the session's ending: revivals shut, stragglers drain, and the
    // run resolves. The dialog stays up with its spinner for the whole wait,
    // and ctrl+c is still the escape hatch out of a drain that will not end.
    store.setQuitting(true);
    await bridge.close();
    await exitCleanly();
  }, [bridge, exitCleanly, overlay, selection]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      // First press asks like `q` does; a second press during a hung drain is
      // the force-exit escape hatch.
      if (state.quitting) {
        renderer.destroy();
        process.exit(1);
      }
      if (phase === "launch") void exitCleanly();
      else store.setOverlay({ kind: "confirm-quit" });
      return;
    }

    if (typeof overlay === "object") {
      if (state.quitting) return;
      if (key.name === "y") void confirm();
      else if (key.name === "n" || key.name === "escape") store.setOverlay("none");
      return;
    }

    if (overlay === "compose") {
      // Only escape acts globally here: every other key belongs to the
      // focused textarea, including the letters bound to shortcuts below.
      if (key.name === "escape") store.setOverlay("none");
      return;
    }

    if (overlay === "comms") {
      // CommsScreen owns j/k/g/G/f while mounted; only escape closes it here.
      if (key.name === "escape") store.setOverlay("none");
      return;
    }

    if (overlay === "transcript") {
      if (key.name === "escape") store.setOverlay("none");
      return;
    }

    if (overlay === "bulletins") {
      if (key.name === "escape" || key.name === "b") store.setOverlay("none");
      return;
    }

    if (phase === "launch") {
      if (key.name === "tab") setField((current) => (current === "goal" ? "charter" : "goal"));
      else if (key.name === "escape") void exitCleanly();
      return;
    }

    switch (key.name) {
      case "j":
      case "down":
        moveSelection(1);
        break;
      case "k":
      case "up":
        moveSelection(-1);
        break;
      case "return":
      case "kpenter":
        if (selection !== undefined) store.setOverlay("transcript");
        break;
      case "b":
        store.setOverlay("bulletins");
        void bridge.fetchBulletins();
        break;
      case "c":
        store.setOverlay("comms");
        void bridge.fetchTraffic();
        break;
      case "m":
        if (selection !== undefined) store.setOverlay("compose");
        break;
      case "i":
        if (selection !== undefined) store.setOverlay({ kind: "confirm-interrupt" });
        break;
      case "q":
        store.setOverlay({ kind: "confirm-quit" });
        break;
      default:
        break;
    }
  });

  if (phase === "launch") {
    return (
      <box width={width} height={height} backgroundColor={theme.bg}>
        <LaunchScreen
          summary={bridge.configSummary}
          mode={bridge.mode}
          goalDraft={state.goalDraft}
          instructionsPath={state.instructionsPath}
          error={state.launchError}
          field={field}
          onGoalChange={store.setGoalDraft}
          onInstructionsChange={store.setInstructionsPath}
          onSubmit={() => void launch()}
          width={width}
        />
      </box>
    );
  }

  if (overlay === "comms") {
    return (
      <CommsScreen traffic={state.traffic} focusPath={selection} width={width} height={height} />
    );
  }

  if (overlay === "transcript" && selection !== undefined) {
    return (
      <TranscriptView
        path={selection}
        agentId={state.detail?.path === selection ? state.detail.id : undefined}
        running={state.detail?.state === "running"}
        reader={bridge.transcript}
        width={width}
        height={height}
      />
    );
  }

  const dialog =
    typeof overlay === "object" ? (
      <ConfirmDialog
        title={overlay.kind === "confirm-quit" ? " CLOSE " : " INTERRUPT "}
        question={
          overlay.kind === "confirm-quit"
            ? "Close the session and drain the swarm?"
            : `Interrupt ${selection ?? "this agent"}?`
        }
        busy={state.quitting}
        busyLabel="CLOSING — draining swarm…"
      />
    ) : null;

  // Overlays replace the monitor rather than floating over it. The renderer
  // repaints only dirty renderables, so a monitor left mounted underneath keeps
  // drawing its once-per-second update straight through whatever is on top.
  if (overlay === "bulletins" || overlay === "compose" || dialog !== null) {
    return (
      <box
        width={width}
        height={height}
        backgroundColor={theme.bg}
        alignItems="center"
        justifyContent="center"
      >
        {overlay === "bulletins" ? (
          <BulletinOverlay bulletins={state.bulletins} width={width} height={height} />
        ) : overlay === "compose" && selection !== undefined ? (
          <ComposeOverlay
            to={selection}
            onSend={(body) => bridge.sendOperatorMessage(selection, body)}
            onClose={() => store.setOverlay("none")}
            width={width}
          />
        ) : (
          dialog
        )}
      </box>
    );
  }

  return (
    <box width={width} height={height} backgroundColor={theme.bg}>
      <MonitorScreen
        state={state}
        workspacePath={bridge.configSummary.workspacePath}
        mode={bridge.mode}
        width={width}
        height={height}
      />
    </box>
  );
};
