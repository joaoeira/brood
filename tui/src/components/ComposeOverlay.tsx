/**
 * Composing a direct operator message to the selected agent. The body is held
 * locally — it only exists between opening the overlay and send/cancel — and
 * the result of the send comes back as an inline error or a closed overlay.
 */
import { useRef, useState } from "react";
import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { theme, truncate } from "../theme";

const bodyKeyBindings: ReadonlyArray<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
];

export interface ComposeOverlayProps {
  readonly to: string;
  readonly onSend: (body: string) => Promise<string | undefined>;
  readonly onClose: () => void;
  readonly width: number;
}

export const ComposeOverlay = ({ to, onSend, onClose, width }: ComposeOverlayProps) => {
  const bodyRef = useRef<TextareaRenderable>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const panelWidth = Math.min(72, Math.max(40, width - 8));

  const submit = (): void => {
    if (sending) return;
    const body = bodyRef.current?.plainText ?? "";
    if (body.trim() === "") {
      setError("The message must not be empty.");
      return;
    }
    setSending(true);
    void onSend(body).then((rejection) => {
      if (rejection === undefined) {
        onClose();
        return;
      }
      setSending(false);
      setError(rejection);
    });
  };

  return (
    <box
      flexDirection="column"
      width={panelWidth}
      border
      borderColor={theme.amber}
      backgroundColor={theme.raised}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      title={` MESSAGE ${to} `}
    >
      <text fg={theme.muted}>
        {"Delivered with run-charter authority; wakes the agent if it is parked."}
      </text>
      <box marginTop={1}>
        <textarea
          ref={bodyRef}
          focused
          minHeight={3}
          maxHeight={8}
          keyBindings={[...bodyKeyBindings]}
          placeholder="What should this agent know?"
          placeholderColor={theme.faint}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.amber}
          onSubmit={submit}
        />
      </box>
      {error === undefined ? null : (
        <box marginTop={1}>
          <text fg={theme.red}>{truncate(error, panelWidth - 4)}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={theme.faint}>{sending ? "sending…" : "⏎ send · ⌥⏎ newline · esc cancel"}</text>
      </box>
    </box>
  );
};
