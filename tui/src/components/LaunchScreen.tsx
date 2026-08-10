/**
 * Where a run is composed. Two fields — the goal and an optional charter path —
 * over a summary of the config that will be used, so the operator can see what
 * they are about to point the swarm at before committing to it.
 *
 * Enter is rebound to submit on the goal textarea (Pi's default puts submit on
 * meta+Enter and newline on Enter); Opt+Enter still inserts a newline.
 */
import { useRef } from "react";
import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import type { KeyBinding } from "@opentui/core";
import type { ConfigSummary } from "../bridge/types";
import { basename, glyphs, theme, tildify, truncate } from "../theme";

export type LaunchField = "goal" | "charter";

export interface LaunchScreenProps {
  readonly summary: ConfigSummary;
  readonly mode: "live" | "demo";
  readonly goalDraft: string;
  readonly instructionsPath: string;
  readonly error: string | undefined;
  readonly field: LaunchField;
  readonly onGoalChange: (value: string) => void;
  readonly onInstructionsChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly width: number;
}

const goalKeyBindings: ReadonlyArray<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
];

interface FieldProps {
  readonly label: string;
  readonly active: boolean;
  readonly children: React.ReactNode;
}

const Field = ({ label, active, children }: FieldProps) => (
  <box flexDirection="row" marginTop={1}>
    <text fg={active ? theme.amber : theme.border}>{glyphs.selected}</text>
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <text fg={active ? theme.amber : theme.muted}>{label}</text>
      {children}
    </box>
  </box>
);

export const LaunchScreen = ({
  summary,
  mode,
  goalDraft,
  instructionsPath,
  error,
  field,
  onGoalChange,
  onInstructionsChange,
  onSubmit,
  width,
}: LaunchScreenProps) => {
  const goalRef = useRef<TextareaRenderable>(null);
  const charterRef = useRef<InputRenderable>(null);
  const contentWidth = Math.max(20, width - 4);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={theme.bg}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <box flexDirection="row">
        <text>
          <span fg={theme.amber}>{`brood ${glyphs.hive}   `}</span>
          <span fg={theme.text}>{truncate(tildify(summary.workspacePath), contentWidth / 2)}</span>
        </text>
        <box flexGrow={1} />
        <text fg={mode === "demo" ? theme.violet : theme.faint}>
          {mode === "demo" ? "demo mode" : "no run"}
        </text>
      </box>

      <box flexDirection="row" marginTop={1}>
        <text>
          <span fg={theme.muted}>{"config  "}</span>
          <span fg={theme.text}>{basename(summary.configPath)}</span>
          <span fg={theme.green}>{" ✓"}</span>
          <span fg={theme.muted}>{"      profiles  "}</span>
          <span fg={theme.text}>{summary.profileNames.join(" · ")}</span>
        </text>
      </box>
      <text fg={theme.muted}>
        {`concurrency ${summary.maxConcurrency} · admissions ${summary.maxAgentAdmissions} · default ${summary.defaultProfile}`}
      </text>

      <Field label="Goal" active={field === "goal"}>
        <textarea
          ref={goalRef}
          focused={field === "goal"}
          initialValue={goalDraft}
          minHeight={3}
          maxHeight={8}
          keyBindings={[...goalKeyBindings]}
          placeholder="What should the swarm accomplish?"
          placeholderColor={theme.faint}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.amber}
          onContentChange={() => onGoalChange(goalRef.current?.plainText ?? "")}
          onSubmit={onSubmit}
        />
      </Field>

      <Field label="Charter" active={field === "charter"}>
        <input
          ref={charterRef}
          focused={field === "charter"}
          value={instructionsPath}
          placeholder="./charter.md   (optional)"
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.amber}
          onInput={onInstructionsChange}
          onSubmit={onSubmit}
        />
      </Field>

      {error === undefined ? null : (
        <box marginTop={1}>
          <text fg={theme.red}>{truncate(error, contentWidth)}</text>
        </box>
      )}

      <box flexGrow={1} />
      <text fg={theme.faint}>{"⏎ launch · ⌥⏎ newline · tab field · esc quit"}</text>
    </box>
  );
};
