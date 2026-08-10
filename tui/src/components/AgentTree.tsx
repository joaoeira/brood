/**
 * The swarm as a tree. Rows are pre-flattened by the store, so this component
 * only decides colour, truncation, and which slice of the list is on screen.
 */
import type { FlatAgent } from "../store";
import { glyphs, stateColor, stateGlyph, theme, truncate } from "../theme";
import { SectionHeader } from "./Section";
import { Spinner, useSpinnerFrame } from "./Spinner";

export interface AgentTreeProps {
  readonly rows: ReadonlyArray<FlatAgent>;
  readonly selection: string | undefined;
  readonly hasStatus: boolean;
  readonly width: number;
  readonly height: number;
}

/** Keeps the cursor roughly centred without scrolling past either end of the list. */
const windowStart = (selectedIndex: number, visible: number, total: number): number => {
  if (total <= visible) return 0;
  const centred = selectedIndex - Math.floor(visible / 2);
  return Math.max(0, Math.min(centred, total - visible));
};

interface AgentRowProps {
  readonly row: FlatAgent;
  readonly selected: boolean;
  readonly width: number;
  readonly spinner: string;
}

const AgentRow = ({ row, selected, width, spinner }: AgentRowProps) => {
  const { agent } = row;
  const glyph = stateGlyph(agent.state) ?? spinner;
  const head = `${row.prefix}${glyph} ${agent.name}`;
  const waitSuffix =
    agent.state === "waiting" && agent.waitTargets.length > 0
      ? ` ${glyphs.waiting}${agent.waitTargets.length}`
      : "";
  const coordination = agent.coordination;
  const mailBadge =
    coordination !== undefined && coordination.unreadMessages > 0
      ? ` ${glyphs.mail}${coordination.unreadMessages}`
      : "";
  const mailColor =
    coordination !== undefined && coordination.unreadUrgent > 0 ? theme.amber : theme.muted;
  const owesBadge =
    coordination !== undefined && coordination.openRequestsIncoming > 0
      ? ` ?${coordination.openRequestsIncoming}`
      : "";
  const tail = agent.activity ?? agent.state;
  const tailWidth =
    width - head.length - waitSuffix.length - mailBadge.length - owesBadge.length - 2;

  return (
    <box flexDirection="row" height={1} backgroundColor={selected ? theme.selection : theme.panel}>
      <text fg={theme.amber}>{selected ? glyphs.selected : " "}</text>
      <text>
        <span fg={theme.faint}>{row.prefix}</span>
        <span fg={stateColor(agent.state)}>{glyph}</span>
        <span fg={selected ? theme.amber : theme.text}>{` ${agent.name}`}</span>
        {waitSuffix === "" ? null : <span fg={theme.blue}>{waitSuffix}</span>}
        {mailBadge === "" ? null : <span fg={mailColor}>{mailBadge}</span>}
        {owesBadge === "" ? null : <span fg={theme.blue}>{owesBadge}</span>}
        {tailWidth > 2 ? <span fg={theme.muted}>{`  ${truncate(tail, tailWidth)}`}</span> : null}
      </text>
    </box>
  );
};

export const AgentTree = ({ rows, selection, hasStatus, width, height }: AgentTreeProps) => {
  const spinner = useSpinnerFrame();
  const contentWidth = width - 2;
  const listHeight = Math.max(1, height - 1);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.agent.path === selection),
  );
  const start = windowStart(selectedIndex, listHeight, rows.length);
  const visible = rows.slice(start, start + listHeight);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <SectionHeader label="AGENTS" width={contentWidth} />
      {rows.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          {hasStatus ? (
            <text fg={theme.muted}>no agents admitted</text>
          ) : (
            <Spinner label="starting swarm…" />
          )}
        </box>
      ) : (
        visible.map((row) => (
          <AgentRow
            key={row.agent.path}
            row={row}
            selected={row.agent.path === selection}
            width={contentWidth - 1}
            spinner={spinner}
          />
        ))
      )}
    </box>
  );
};
