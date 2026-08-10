/**
 * The shared board, newest last. Bulletins are the one place agents write prose
 * meant for other agents, so this reads as a document rather than a log: author
 * headers in amber, bodies wrapped at the panel width.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { BulletinView } from "../brood";
import { glyphs, theme, wrap } from "../theme";

export interface BulletinOverlayProps {
  readonly bulletins: ReadonlyArray<BulletinView>;
  readonly width: number;
  readonly height: number;
}

interface Line {
  readonly text: string;
  readonly color: string;
}

export const BulletinOverlay = ({ bulletins, width, height }: BulletinOverlayProps) => {
  const panelWidth = Math.max(30, Math.round(width * 0.7));
  const panelHeight = Math.max(8, Math.round(height * 0.7));
  const contentWidth = panelWidth - 4;
  const viewportRows = Math.max(1, panelHeight - 3);

  const lines = useMemo((): ReadonlyArray<Line> => {
    const out: Array<Line> = [];
    for (const bulletin of bulletins) {
      if (out.length > 0) out.push({ text: "", color: theme.faint });
      out.push({ text: `#${bulletin.sequence} ${bulletin.author}`, color: theme.amber });
      for (const line of wrap(bulletin.body, contentWidth)) {
        out.push({ text: line, color: theme.text });
      }
    }
    return out;
  }, [bulletins, contentWidth]);

  const maxScroll = Math.max(0, lines.length - viewportRows);
  const [scrollTop, setScrollTop] = useState(0);
  const boxRef = useRef<ScrollBoxRenderable>(null);

  useKeyboard((key) => {
    const step = (delta: number): void =>
      setScrollTop((current) => Math.max(0, Math.min(maxScroll, current + delta)));
    if (key.name === "j" || key.name === "down") step(1);
    else if (key.name === "k" || key.name === "up") step(-1);
    else if (key.name === "d" && key.ctrl) step(Math.floor(viewportRows / 2));
    else if (key.name === "u" && key.ctrl) step(-Math.floor(viewportRows / 2));
    else if (key.name === "g") setScrollTop(0);
    else if (key.name === "G" || (key.name === "g" && key.shift)) setScrollTop(maxScroll);
  });

  useEffect(() => {
    setScrollTop((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useEffect(() => {
    if (boxRef.current !== null) boxRef.current.scrollTop = scrollTop;
  }, [scrollTop, lines]);

  return (
    <box
      flexDirection="column"
      width={panelWidth}
      height={panelHeight}
      backgroundColor={theme.raised}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={` BULLETIN ${glyphs.hive} `}
      titleColor={theme.amber}
      paddingLeft={1}
      paddingRight={1}
    >
      {lines.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.faint}>no bulletins posted yet</text>
        </box>
      ) : (
        <scrollbox
          ref={boxRef}
          flexGrow={1}
          scrollY
          scrollbarOptions={{ visible: false }}
          rootOptions={{ backgroundColor: theme.raised }}
          wrapperOptions={{ backgroundColor: theme.raised }}
          viewportOptions={{ backgroundColor: theme.raised }}
          contentOptions={{ backgroundColor: theme.raised }}
        >
          {lines.map((line, index) => (
            <text key={index} height={1} fg={line.color} bg={theme.raised}>
              {line.text}
            </text>
          ))}
        </scrollbox>
      )}
      <text fg={theme.faint}>
        {maxScroll > 0 ? "j/k scroll · g/G ends · esc back" : "esc back"}
      </text>
    </box>
  );
};
