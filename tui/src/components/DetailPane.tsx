/**
 * Everything known about the selected agent. Sections that would be empty are
 * omitted entirely rather than rendered as headings over nothing, so the pane
 * stays legible for a queued agent and a finished one alike.
 */
import type { AgentDetail } from "../brood";
import type { ToolEvent } from "../store";
import { formatShortDuration, glyphs, stateColor, theme, truncate, wrap } from "../theme";
import { SectionHeader } from "./Section";
import { useSpinnerFrame } from "./Spinner";

const OUTCOME_LINES = 12;
const RECENT_TOOLS = 10;

const formatCoordination = (counts: NonNullable<AgentDetail["coordination"]>): string => {
  const parts: Array<string> = [];
  if (counts.unreadMessages > 0) {
    const urgent = counts.unreadUrgent > 0 ? ` (${counts.unreadUrgent} urgent)` : "";
    parts.push(`mail ${counts.unreadMessages}${urgent}`);
  }
  if (counts.openRequestsIncoming > 0) parts.push(`owes ${counts.openRequestsIncoming} replies`);
  if (counts.openRequestsOutgoing > 0) parts.push(`awaits ${counts.openRequestsOutgoing}`);
  if (counts.pendingOperatorMessages > 0) parts.push(`operator ${counts.pendingOperatorMessages}`);
  if (counts.unseenBulletins > 0) parts.push(`bulletins ${counts.unseenBulletins} unseen`);
  return parts.join(" · ");
};

export interface DetailPaneProps {
  readonly detail: AgentDetail | undefined;
  readonly tools: ReadonlyArray<ToolEvent>;
  readonly selection: string | undefined;
  readonly width: number;
  readonly height: number;
}

interface OutcomeProps {
  readonly outcome: NonNullable<AgentDetail["outcome"]>;
  readonly width: number;
}

const OutcomeBody = ({ outcome, width }: OutcomeProps) => {
  switch (outcome._tag) {
    case "Completed": {
      const lines = wrap(outcome.result.summary, width).slice(0, OUTCOME_LINES);
      return (
        <>
          {lines.map((line, index) => (
            <text key={index} fg={theme.muted}>
              {line}
            </text>
          ))}
          {outcome.result.truncated ? (
            <text fg={theme.faint}>
              {`… truncated from ${outcome.result.originalCharacterCount} characters`}
            </text>
          ) : null}
        </>
      );
    }
    case "Failed":
      return (
        <>
          <text fg={theme.red}>{outcome.code}</text>
          {wrap(outcome.message, width)
            .slice(0, OUTCOME_LINES)
            .map((line, index) => (
              <text key={index} fg={theme.red}>
                {line}
              </text>
            ))}
        </>
      );
    case "Interrupted":
      return <text fg={theme.violet}>{outcome.reason}</text>;
  }
};

interface ToolRowProps {
  readonly tool: ToolEvent;
  readonly width: number;
  readonly spinner: string;
}

const ToolRow = ({ tool, width, spinner }: ToolRowProps) => {
  const running = tool.endedAt === undefined;
  const mark = running ? spinner : tool.isError === true ? glyphs.bad : glyphs.ok;
  const markColor = running ? theme.amber : tool.isError === true ? theme.red : theme.green;
  const elapsed = formatShortDuration((tool.endedAt ?? Date.now()) - tool.startedAt);
  return (
    <text>
      <span fg={markColor}>{mark}</span>
      <span fg={theme.text}>{` ${truncate(tool.toolName, Math.max(4, width - 12))}`}</span>
      <span fg={theme.faint}>{`  ${elapsed}`}</span>
    </text>
  );
};

export const DetailPane = ({ detail, tools, selection, width, height }: DetailPaneProps) => {
  const spinner = useSpinnerFrame();
  const contentWidth = Math.max(8, width - 2);

  if (detail === undefined) {
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        height={height}
        backgroundColor={theme.bg}
        paddingLeft={1}
        paddingRight={1}
        justifyContent="center"
        alignItems="center"
      >
        <text fg={theme.faint}>
          {selection === undefined ? "no agent selected" : `loading ${selection}…`}
        </text>
      </box>
    );
  }

  const recent = tools.slice(-RECENT_TOOLS);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      height={height}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <b fg={theme.amber}>{truncate(detail.path, contentWidth)}</b>
      </text>
      <text>
        <span fg={stateColor(detail.state)}>{detail.state}</span>
        <span fg={theme.faint}>{`  ${formatShortDuration(detail.durationMillis)}`}</span>
      </text>
      <text fg={theme.muted}>
        {truncate(
          `${detail.profile.name} · ${detail.profile.provider}/${detail.profile.model} · thinking ${detail.profile.thinkingLevel}`,
          contentWidth,
        )}
      </text>

      {detail.activity === undefined ? null : (
        <text fg={theme.text}>{truncate(detail.activity, contentWidth)}</text>
      )}

      {detail.waitTargets.length === 0 ? null : (
        <box flexDirection="column" marginTop={1}>
          <SectionHeader label="WAITING ON" width={contentWidth} />
          <text fg={theme.blue}>{truncate(detail.waitTargets.join(", "), contentWidth)}</text>
        </box>
      )}

      {detail.coordination === undefined ? null : (
        <box flexDirection="column" marginTop={1}>
          <SectionHeader label="COMMS" width={contentWidth} />
          <text fg={theme.muted}>
            {truncate(formatCoordination(detail.coordination), contentWidth)}
          </text>
        </box>
      )}

      {detail.outcome === undefined ? null : (
        <box flexDirection="column" marginTop={1}>
          <SectionHeader label="OUTCOME" width={contentWidth} />
          <OutcomeBody outcome={detail.outcome} width={contentWidth} />
        </box>
      )}

      {recent.length === 0 ? null : (
        <box flexDirection="column" marginTop={1}>
          <SectionHeader label="RECENT" width={contentWidth} />
          {recent.map((tool) => (
            <ToolRow key={tool.toolCallId} tool={tool} width={contentWidth} spinner={spinner} />
          ))}
        </box>
      )}

      <box flexGrow={1} />
      <text fg={theme.faint}>{"⏎ transcript · m message · i interrupt"}</text>
    </box>
  );
};
