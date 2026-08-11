/**
 * A full-screen read of one agent's Pi session, rebuilt from disk every second.
 *
 * The file only ever contains settled messages, so this is a record rather than
 * a stream — which is why it follows the tail while the agent is running but
 * stops the moment the operator scrolls up.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { glyphs, rule, theme, truncate, wrap } from "../theme";
import type { TranscriptEntry } from "../transcript/parse";
import { useTranscript, type TranscriptReader } from "../transcript/watch";
import { wheelRows, type WheelEventLike } from "./wheel";

const COMMAND_PREVIEW_LINES = 3;
const ASSISTANT_PREVIEW_LINES = 12;

export interface TranscriptViewProps {
  readonly path: string;
  readonly agentId: string | undefined;
  readonly running: boolean;
  readonly reader: TranscriptReader;
  readonly width: number;
  readonly height: number;
}

interface Line {
  readonly text: string;
  readonly color: string;
}

const blank: Line = { text: "", color: theme.faint };

const renderEntry = (entry: TranscriptEntry, width: number): ReadonlyArray<Line> => {
  switch (entry.kind) {
    case "user": {
      const head: Line = { text: `${glyphs.inbound} command`, color: theme.amber };
      if (entry.envelope !== undefined) {
        return [head, { text: `  ${entry.envelope}`, color: theme.faint }, blank];
      }
      const body = wrap(entry.text, width - 2)
        .slice(0, COMMAND_PREVIEW_LINES)
        .map((line): Line => ({ text: `  ${line}`, color: theme.muted }));
      return [head, ...body, blank];
    }
    case "assistant": {
      const all = wrap(entry.text, width - 2);
      const shown = all.slice(0, ASSISTANT_PREVIEW_LINES);
      const overflow = all.length - shown.length;
      return [
        { text: `${glyphs.outbound} assistant`, color: theme.amberDim },
        ...shown.map((line): Line => ({ text: `  ${line}`, color: theme.text })),
        ...(overflow > 0 ? [{ text: `  … (+${overflow} lines)`, color: theme.faint }] : []),
        blank,
      ];
    }
    case "tool": {
      const lines: Array<Line> = [
        {
          text: truncate(`${glyphs.outbound} ${entry.toolName}  ${entry.argsPreview}`, width),
          color: theme.blue,
        },
      ];
      if (entry.ok === undefined) {
        lines.push({ text: "  … pending", color: theme.faint });
      } else {
        lines.push({
          text: truncate(
            `  ${entry.ok ? glyphs.ok : glyphs.bad} ${entry.resultPreview ?? ""}`,
            width,
          ),
          color: entry.ok ? theme.muted : theme.red,
        });
      }
      if (entry.suspended === true) {
        lines.push({ text: `  ${glyphs.suspended} suspended`, color: theme.violet });
      }
      lines.push(blank);
      return lines;
    }
    case "compaction":
      return [
        {
          text: truncate(`── context compacted: ${entry.summary} ──`, width),
          color: theme.faint,
        },
        blank,
      ];
  }
};

export const TranscriptView = ({
  path,
  agentId,
  running,
  reader,
  width,
  height,
}: TranscriptViewProps) => {
  const { snapshot, loading } = useTranscript(reader, agentId, true);
  const contentWidth = Math.max(20, width - 2);
  const viewportRows = Math.max(1, height - 3);

  const lines = useMemo((): ReadonlyArray<Line> => {
    if (snapshot === undefined) return [];
    return snapshot.transcript.entries.flatMap((entry) => renderEntry(entry, contentWidth));
  }, [snapshot, contentWidth]);

  const maxScroll = Math.max(0, lines.length - viewportRows);
  const [scrollTop, setScrollTop] = useState(0);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<ScrollBoxRenderable>(null);

  const step = (delta: number): void => {
    setFollow(false);
    setScrollTop((current) => {
      const next = Math.max(0, Math.min(maxScroll, current + delta));
      if (delta > 0 && next >= maxScroll) setFollow(true);
      return next;
    });
  };

  const onWheel = (event: WheelEventLike): void => {
    const delta = wheelRows(event);
    if (delta !== undefined) step(delta);
  };

  useKeyboard((key) => {
    if (key.name === "j" || key.name === "down") step(1);
    else if (key.name === "k" || key.name === "up") step(-1);
    else if (key.name === "d" && key.ctrl) step(Math.floor(viewportRows / 2));
    else if (key.name === "u" && key.ctrl) step(-Math.floor(viewportRows / 2));
    else if (key.name === "g" && !key.shift) {
      setFollow(false);
      setScrollTop(0);
    } else if (key.name === "G" || (key.name === "g" && key.shift)) {
      setFollow(true);
      setScrollTop(maxScroll);
    }
  });

  // Following is only meaningful while the agent is still producing turns; once
  // it settles the view stays exactly where the operator left it.
  useEffect(() => {
    setScrollTop((current) => (follow && running ? maxScroll : Math.min(current, maxScroll)));
  }, [follow, running, maxScroll]);

  useEffect(() => {
    if (boxRef.current !== null) boxRef.current.scrollTop = scrollTop;
  }, [scrollTop, lines]);

  const entryCount = snapshot?.transcript.entries.length ?? 0;
  const header = `TRANSCRIPT ${path}${snapshot === undefined ? "" : ` · ${snapshot.fileName}`} · ${entryCount} entries`;

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={onWheel}
    >
      <text>
        <span fg={theme.amber}>{truncate(header, contentWidth)}</span>
      </text>
      <text fg={theme.border}>{rule(contentWidth)}</text>

      {lines.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.faint}>{loading ? "reading session…" : "no session yet — queued"}</text>
        </box>
      ) : (
        <scrollbox
          ref={boxRef}
          flexGrow={1}
          scrollY
          rootOptions={{ backgroundColor: theme.bg }}
          wrapperOptions={{ backgroundColor: theme.bg }}
          viewportOptions={{ backgroundColor: theme.bg }}
          contentOptions={{ backgroundColor: theme.bg }}
        >
          {lines.map((line, index) => (
            <text key={index} height={1} fg={line.color} bg={theme.bg}>
              {line.text}
            </text>
          ))}
        </scrollbox>
      )}

      <text fg={theme.faint}>
        {`esc back · j/k scroll · g/G ends${follow && running ? " · following" : ""}`}
      </text>
    </box>
  );
};
