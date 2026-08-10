/**
 * A running narration of supervisor activity. Only the tail that fits is drawn;
 * the store keeps the rest so nothing is lost when the terminal is short.
 */
import type { TickerEntry, Tone } from "../store";
import { formatTimeOfDay, theme, truncate } from "../theme";
import { SectionHeader } from "./Section";

const TONE_COLORS: Record<Tone, string> = {
  muted: theme.muted,
  info: theme.text,
  warn: theme.amber,
  error: theme.red,
};

export interface EventTickerProps {
  readonly entries: ReadonlyArray<TickerEntry>;
  readonly width: number;
  readonly height: number;
}

export const EventTicker = ({ entries, width, height }: EventTickerProps) => {
  const contentWidth = Math.max(8, width - 2);
  const rows = Math.max(1, height - 1);
  const visible = entries.slice(-rows);

  return (
    <box
      flexDirection="column"
      height={height}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <SectionHeader label="EVENTS" width={contentWidth} />
      {visible.length === 0 ? (
        <text fg={theme.faint}>waiting for the first event…</text>
      ) : (
        visible.map((entry, index) => (
          <text key={`${entry.at}-${index}`}>
            <span fg={theme.faint}>{`${formatTimeOfDay(entry.at)} `}</span>
            <span fg={TONE_COLORS[entry.tone]}>{truncate(entry.text, contentWidth - 9)}</span>
          </text>
        ))
      )}
    </box>
  );
};
