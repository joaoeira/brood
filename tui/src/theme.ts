/**
 * The hive look: one warm dark palette, one glyph set, and the small pure
 * formatters every screen shares. Structure in this UI comes from background
 * shifts and single-line rules rather than boxes, so the rule/pad helpers here
 * are load-bearing rather than decorative.
 */
import type { AgentState } from "./brood";

export const theme = {
  bg: "#0B0A08",
  panel: "#12100B",
  raised: "#1A160E",
  selection: "#2A2312",
  text: "#E2DDD2",
  muted: "#8B8578",
  faint: "#57524A",
  amber: "#E8A33D",
  amberDim: "#8A6323",
  green: "#3FB950",
  red: "#F85149",
  blue: "#6CA4E0",
  violet: "#B18BE8",
  border: "#2C2820",
} as const;

export const glyphs = {
  hive: "⬡",
  selected: "┃",
  queued: "○",
  starting: "◌",
  waiting: "◇",
  completed: "●",
  failed: "✖",
  interrupted: "◼",
  treeTee: "├─",
  treeCorner: "└─",
  treeBar: "│ ",
  treeGap: "  ",
  ok: "✓",
  bad: "✗",
  suspended: "⏸",
  inbound: "◂",
  outbound: "▸",
} as const;

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const STATE_COLORS: Record<AgentState, string> = {
  starting: theme.muted,
  queued: theme.muted,
  running: theme.amber,
  waiting: theme.blue,
  completed: theme.green,
  failed: theme.red,
  interrupted: theme.violet,
};

export const stateColor = (state: AgentState): string => STATE_COLORS[state];

/** Running agents have no static glyph — the caller substitutes a spinner frame. */
export const stateGlyph = (state: AgentState): string | undefined => {
  switch (state) {
    case "running":
      return undefined;
    case "starting":
      return glyphs.starting;
    case "queued":
      return glyphs.queued;
    case "waiting":
      return glyphs.waiting;
    case "completed":
      return glyphs.completed;
    case "failed":
      return glyphs.failed;
    case "interrupted":
      return glyphs.interrupted;
  }
};

export const swarmStateColor = (state: string): string => {
  switch (state) {
    case "running":
      return theme.amber;
    case "draining":
      return theme.violet;
    case "completed":
      return theme.green;
    default:
      return theme.muted;
  }
};

export const rule = (width: number): string => "─".repeat(Math.max(0, width));

/** Hard-truncates to `width` columns, spending the last column on an ellipsis. */
export const truncate = (text: string, width: number): string => {
  if (width <= 0) return "";
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
};

export const padEnd = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

/** Greedy word wrap. Words longer than the width are hard-split rather than overflowed. */
export const wrap = (text: string, width: number): ReadonlyArray<string> => {
  if (width <= 0) return [];
  const lines: Array<string> = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      let candidate = word;
      while (candidate.length > width) {
        if (current !== "") {
          lines.push(current);
          current = "";
        }
        lines.push(candidate.slice(0, width));
        candidate = candidate.slice(width);
      }
      if (current === "") current = candidate;
      else if (current.length + 1 + candidate.length <= width) current = `${current} ${candidate}`;
      else {
        lines.push(current);
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
};

export const formatClock = (milliseconds: number): string => {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
};

export const formatShortDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return formatClock(milliseconds);
};

export const formatTimeOfDay = (epochMillis: number): string => {
  const date = new Date(epochMillis);
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
};

/** Renders an absolute path with `$HOME` collapsed, the way a shell prompt would. */
export const tildify = (path: string): string => {
  const home = process.env["HOME"];
  if (home === undefined || home === "" || !path.startsWith(home)) return path;
  return `~${path.slice(home.length)}`;
};
