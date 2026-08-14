/**
 * The only two destructive actions in the UI get the same small centred panel.
 * Closing keeps the dialog on screen while the swarm drains, because that wait
 * is the part an operator most needs to see is deliberate.
 */
import { theme } from "../theme";
import { Spinner } from "./Spinner";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly question: string;
  readonly busy: boolean;
  readonly busyLabel: string;
}

export const ConfirmDialog = ({ title, question, busy, busyLabel }: ConfirmDialogProps) => (
  <box
    flexDirection="column"
    backgroundColor={theme.raised}
    border
    borderStyle="rounded"
    borderColor={theme.border}
    title={title}
    titleColor={theme.amber}
    paddingLeft={2}
    paddingRight={2}
    paddingTop={1}
    paddingBottom={1}
    minWidth={40}
  >
    <text fg={theme.text}>{question}</text>
    <box height={1} />
    {busy ? (
      <Spinner label={busyLabel} />
    ) : (
      <text fg={theme.faint}>{"y confirm · n/esc cancel"}</text>
    )}
  </box>
);
