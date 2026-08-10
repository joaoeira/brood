/**
 * The one-line header: what the swarm is doing, how much capacity is left, and
 * which workspace it is doing it in.
 */
import type { SwarmStatus } from "../brood";
import { basename, formatClock, glyphs, swarmStateColor, theme, truncate } from "../theme";

export interface StatusBarProps {
  readonly status: SwarmStatus | undefined;
  readonly workspacePath: string;
  readonly mode: "live" | "demo";
  readonly width: number;
}

export const StatusBar = ({ status, workspacePath, mode, width }: StatusBarProps) => {
  const state = status?.state ?? "not_started";
  const capacity =
    status === undefined
      ? "runs 0/0 · admissions 0/0"
      : `runs ${status.capacity.runs.active}/${status.capacity.runs.limit} · admissions ${status.capacity.admissions.used}/${status.capacity.admissions.limit}`;

  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={theme.amber}>{`brood ${glyphs.hive} `}</span>
        <span fg={swarmStateColor(state)}>{state}</span>
        <span fg={theme.faint}>{`  ${formatClock(status?.elapsedMillis ?? 0)}`}</span>
      </text>
      <box flexGrow={1} />
      <text fg={theme.muted}>{capacity}</text>
      <box flexGrow={1} />
      <text>
        {mode === "demo" ? <span fg={theme.violet}>{"demo  "}</span> : null}
        <span fg={theme.faint}>{truncate(basename(workspacePath), Math.max(8, width / 4))}</span>
      </text>
    </box>
  );
};
