/**
 * The traffic intercept console: every message, question, reply, and operator
 * transmission in the run, with read state and full bodies. A feed on top,
 * the selected record decoded below — dense rows, hard truncation, and status
 * as the only loud color. Owns its selection and filter keys while mounted;
 * App keeps only escape.
 */
import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TrafficView } from "../brood";
import { formatTimeOfDay, glyphs, rule, theme, truncate, wrap } from "../theme";

export type CommsFilter = "all" | "agent" | "unread";

export interface CommsScreenProps {
  readonly traffic: ReadonlyArray<TrafficView>;
  readonly focusPath: string | undefined;
  readonly width: number;
  readonly height: number;
}

const DETAIL_HEIGHT = 10;

const KIND_GLYPHS: Record<TrafficView["kind"], string> = {
  message: "✉",
  request: "?",
  reply: "↩",
  operator: glyphs.operator,
};

const STATUS_COLORS: Record<TrafficView["status"], string> = {
  unread: theme.amber,
  pending: theme.amber,
  read: theme.faint,
  sent: theme.faint,
  answered: theme.green,
  delivered: theme.blue,
  void: theme.red,
};

const kindColor = (record: TrafficView): string => {
  if (record.kind === "operator") return theme.violet;
  if (record.urgent) return theme.red;
  if (record.kind === "request") return theme.blue;
  return theme.muted;
};

interface FeedRowProps {
  readonly record: TrafficView;
  readonly selected: boolean;
  readonly width: number;
}

const FeedRow = ({ record, selected, width }: FeedRowProps) => {
  const clock = formatTimeOfDay(record.at);
  const glyph = record.urgent && record.kind === "message" ? "⚡" : KIND_GLYPHS[record.kind];
  const route = truncate(
    `${record.from} → ${record.to}`,
    Math.max(12, Math.min(36, Math.floor(width * 0.35))),
  );
  const status = record.status.toUpperCase();
  const used = clock.length + glyph.length + route.length + status.length + 7;
  const preview = truncate(record.body, Math.max(0, width - used));
  return (
    <box flexDirection="row" height={1} backgroundColor={selected ? theme.selection : theme.bg}>
      <text fg={theme.amber}>{selected ? glyphs.selected : " "}</text>
      <text>
        <span fg={theme.faint}>{clock}</span>
        <span fg={kindColor(record)}>{` ${glyph} `}</span>
        <span fg={selected ? theme.text : theme.muted}>{route}</span>
        <span fg={STATUS_COLORS[record.status]}>{`  ${status}`}</span>
        <span fg={selected ? theme.muted : theme.faint}>{`  ${preview}`}</span>
      </text>
    </box>
  );
};

const windowStart = (selectedIndex: number, visible: number, total: number): number => {
  if (total <= visible) return 0;
  const centred = selectedIndex - Math.floor(visible / 2);
  return Math.max(0, Math.min(centred, total - visible));
};

export const CommsScreen = ({ traffic, focusPath, width, height }: CommsScreenProps) => {
  const [filter, setFilter] = useState<CommsFilter>("all");
  // Selection counts from the END of the feed so it stays pinned to the
  // newest record as traffic streams in, unless the operator has moved.
  const [fromEnd, setFromEnd] = useState(0);

  const filtered = useMemo(() => {
    switch (filter) {
      case "all":
        return traffic;
      case "unread":
        return traffic.filter(({ status }) => status === "unread" || status === "pending");
      case "agent":
        return focusPath === undefined
          ? traffic
          : traffic.filter(({ from, to }) => from === focusPath || to === focusPath);
    }
  }, [traffic, filter, focusPath]);

  const selectedIndex = Math.max(0, filtered.length - 1 - fromEnd);
  const selected = filtered[selectedIndex];

  useKeyboard((key) => {
    if (key.name === "j" || key.name === "down") setFromEnd((current) => Math.max(0, current - 1));
    else if (key.name === "k" || key.name === "up") {
      setFromEnd((current) => Math.min(Math.max(0, filtered.length - 1), current + 1));
    } else if (key.name === "g") setFromEnd(Math.max(0, filtered.length - 1));
    else if (key.name === "G") setFromEnd(0);
    else if (key.name === "f") {
      setFromEnd(0);
      setFilter((current) =>
        current === "all" ? "agent" : current === "agent" ? "unread" : "all",
      );
    }
  });

  useEffect(() => {
    setFromEnd((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const contentWidth = Math.max(20, width - 2);
  const unread = traffic.filter(({ status }) => status === "unread" || status === "pending").length;
  const feedHeight = Math.max(3, height - 3 - DETAIL_HEIGHT);
  const start = windowStart(selectedIndex, feedHeight, filtered.length);
  const visible = filtered.slice(start, start + feedHeight);
  const filterLabel =
    filter === "all" ? "ALL" : filter === "unread" ? "UNREAD" : (focusPath ?? "AGENT");

  const header = ` COMMS ▓▒░ TRAFFIC ${traffic.length} · UNREAD ${unread} `;

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      <box flexDirection="row" height={1} backgroundColor={theme.panel} paddingLeft={1}>
        <text>
          <b fg={theme.amber}>{header}</b>
          <span fg={theme.border}>{rule(Math.max(0, contentWidth - header.length - 9))}</span>
          <span fg={theme.faint}>{" esc back"}</span>
        </text>
      </box>

      <box flexDirection="column" height={feedHeight} paddingLeft={1} paddingRight={1}>
        {filtered.length === 0 ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.faint}>
              {traffic.length === 0
                ? "no traffic yet — the swarm has not spoken"
                : "nothing matches this filter"}
            </text>
          </box>
        ) : (
          visible.map((record) => (
            <FeedRow
              key={record.sequence}
              record={record}
              selected={record.sequence === selected?.sequence}
              width={contentWidth - 1}
            />
          ))
        )}
      </box>

      <box
        flexDirection="column"
        height={DETAIL_HEIGHT}
        backgroundColor={theme.panel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text>
          <span fg={theme.muted}>{"DETAIL "}</span>
          <span fg={theme.border}>{rule(Math.max(0, contentWidth - 7))}</span>
        </text>
        {selected === undefined ? (
          <text fg={theme.faint}>nothing selected</text>
        ) : (
          <>
            <text>
              <span
                fg={kindColor(selected)}
              >{`${selected.urgent && selected.kind === "message" ? "⚡" : KIND_GLYPHS[selected.kind]} `}</span>
              <span fg={theme.text}>
                {truncate(`${selected.from} → ${selected.to}`, contentWidth - 30)}
              </span>
              <span
                fg={theme.faint}
              >{` · ${selected.kind}${selected.urgent ? " · urgent" : ""} · ${formatTimeOfDay(selected.at)}`}</span>
            </text>
            <text>
              <span fg={STATUS_COLORS[selected.status]}>{selected.status.toUpperCase()}</span>
              <span fg={theme.faint}>
                {selected.statusAt === undefined ? "" : ` at ${formatTimeOfDay(selected.statusAt)}`}
              </span>
            </text>
            {wrap(selected.body, contentWidth - 2)
              .slice(0, DETAIL_HEIGHT - 4)
              .map((line, index) => (
                <text key={index}>
                  <span fg={theme.amber}>{glyphs.selected}</span>
                  <span fg={theme.text}>{` ${line}`}</span>
                </text>
              ))}
          </>
        )}
      </box>

      <box height={1} backgroundColor={theme.bg} paddingLeft={1}>
        <text
          fg={theme.faint}
        >{`j/k select · g/G ends · f filter: ${filterLabel} · esc back`}</text>
      </box>
    </box>
  );
};
