/**
 * The swarm as a tree. Rows are pre-flattened by the store, so this component
 * only decides colour, truncation, and which slice of the list is on screen.
 */
import { useEffect, useRef, useState } from "react";
import { store, type FlatAgent } from "../store";
import { glyphs, stateColor, stateGlyph, theme, truncate } from "../theme";
import { SectionHeader } from "./Section";
import { Spinner, useSpinnerFrame } from "./Spinner";
import { wheelRows, type WheelEventLike } from "./wheel";

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
  readonly onSelect: () => void;
}

const AgentRow = ({ row, selected, width, spinner, onSelect }: AgentRowProps) => {
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
  const revivalBadge =
    agent.revivals !== undefined && agent.revivals > 0 ? ` ${glyphs.revived}${agent.revivals}` : "";
  const tail = agent.activity ?? agent.state;
  const tailWidth =
    width -
    head.length -
    waitSuffix.length -
    mailBadge.length -
    owesBadge.length -
    revivalBadge.length -
    2;

  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={selected ? theme.selection : theme.panel}
      onMouseDown={onSelect}
    >
      <text fg={theme.amber}>{selected ? glyphs.selected : " "}</text>
      <text>
        <span fg={theme.faint}>{row.prefix}</span>
        <span fg={stateColor(agent.state)}>{glyph}</span>
        <span fg={selected ? theme.amber : theme.text}>{` ${agent.name}`}</span>
        {waitSuffix === "" ? null : <span fg={theme.blue}>{waitSuffix}</span>}
        {mailBadge === "" ? null : <span fg={mailColor}>{mailBadge}</span>}
        {owesBadge === "" ? null : <span fg={theme.blue}>{owesBadge}</span>}
        {revivalBadge === "" ? null : <span fg={theme.violet}>{revivalBadge}</span>}
        {tailWidth > 2 ? <span fg={theme.muted}>{`  ${truncate(tail, tailWidth)}`}</span> : null}
      </text>
    </box>
  );
};

export const AgentTree = ({ rows, selection, hasStatus, width, height }: AgentTreeProps) => {
  const spinner = useSpinnerFrame();
  // The wheel detaches the viewport from the selection; any keyboard
  // selection change snaps it back to the centred-cursor window.
  const [wheelStart, setWheelStart] = useState<number | undefined>(undefined);
  const contentWidth = width - 2;
  const listHeight = Math.max(1, height - 1);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.agent.path === selection),
  );
  const maxStart = Math.max(0, rows.length - listHeight);
  const start = Math.min(
    wheelStart ?? windowStart(selectedIndex, listHeight, rows.length),
    maxStart,
  );
  const visible = rows.slice(start, start + listHeight);

  // Clicking a row selects it without recentring the view — the row is already
  // on screen; only keyboard navigation snaps the window back to the cursor.
  const clickPinned = useRef(false);
  useEffect(() => {
    if (clickPinned.current) {
      clickPinned.current = false;
      return;
    }
    setWheelStart(undefined);
  }, [selection]);

  const onWheel = (event: WheelEventLike): void => {
    const delta = wheelRows(event);
    if (delta === undefined) return;
    setWheelStart(Math.max(0, Math.min(maxStart, start + delta)));
  };

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={onWheel}
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
            onSelect={() => {
              clickPinned.current = true;
              setWheelStart(start);
              store.setSelection(row.agent.path);
            }}
          />
        ))
      )}
    </box>
  );
};
