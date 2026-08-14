/**
 * The running-swarm layout: status bar, tree beside detail, then the ticker.
 * Heights are computed here rather than left to flex so the ticker keeps its
 * seven rows on a short terminal instead of collapsing into the tree.
 */
import type { AppState } from "../store";
import { flattenAgents, isSettled, unseenBulletins } from "../store";
import { theme } from "../theme";
import { AgentTree } from "./AgentTree";
import { DetailPane } from "./DetailPane";
import { EventTicker } from "./EventTicker";
import { StatusBar } from "./StatusBar";

const TREE_WIDTH = 36;
const TICKER_HEIGHT = 7;

const OUTCOME_COLORS: Record<string, string> = {
  completed: theme.green,
  failed: theme.red,
  interrupted: theme.violet,
};

export interface MonitorScreenProps {
  readonly state: AppState;
  readonly workspacePath: string;
  readonly mode: "live" | "demo";
  readonly width: number;
  readonly height: number;
}

export const MonitorScreen = ({
  state,
  workspacePath,
  mode,
  width,
  height,
}: MonitorScreenProps) => {
  const rows = flattenAgents(state.status?.agents ?? []);
  const unseen = unseenBulletins(state);
  const tools = state.detail === undefined ? [] : (state.recentTools.get(state.detail.id) ?? []);
  const settled = isSettled(state);
  const bannerHeight = state.runOutcome === undefined && !settled ? 0 : 1;
  const bodyHeight = Math.max(3, height - 1 - TICKER_HEIGHT - 1 - bannerHeight);
  const treeWidth = Math.min(TREE_WIDTH, Math.max(20, Math.floor(width / 2)));

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      <StatusBar
        status={state.status}
        workspacePath={workspacePath}
        mode={mode}
        settled={settled}
        width={width}
      />

      <box flexDirection="row" height={bodyHeight}>
        <AgentTree
          rows={rows}
          selection={state.selection}
          hasStatus={state.status !== undefined}
          width={treeWidth}
          height={bodyHeight}
        />
        <DetailPane
          detail={state.detail}
          tools={tools}
          selection={state.selection}
          width={width - treeWidth}
          height={bodyHeight}
        />
      </box>

      {state.runOutcome !== undefined ? (
        <box
          flexDirection="row"
          height={1}
          backgroundColor={theme.panel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={OUTCOME_COLORS[state.runOutcome.kind] ?? theme.text}>
            {`run ${state.runOutcome.kind} — ${state.runOutcome.text.split("\n")[0] ?? ""}`}
          </text>
          <box flexGrow={1} />
          <text fg={theme.faint}>q quit</text>
        </box>
      ) : settled ? (
        <box
          flexDirection="row"
          height={1}
          backgroundColor={theme.panel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text>
            <b fg={theme.violet}>{"SETTLED"}</b>
            <span fg={theme.muted}>{" · swarm dormant — m to message · q to close"}</span>
          </text>
        </box>
      ) : null}

      <EventTicker entries={state.ticker} width={width} height={TICKER_HEIGHT} />

      <box height={1} backgroundColor={theme.bg} paddingLeft={1}>
        <text fg={theme.faint}>
          <span>{"j/k select · ⏎ transcript · c comms · b bulletins"}</span>
          {unseen === 0 ? null : <span fg={theme.amber}>{` ●${unseen}`}</span>}
          <span>{" · m message · i interrupt · q close"}</span>
        </text>
      </box>
    </box>
  );
};
