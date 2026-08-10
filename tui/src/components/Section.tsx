/**
 * The one structural divider this UI uses: a label followed by a rule that eats
 * the rest of the line. Panels have no borders, so these caps carry all of the
 * visual grouping.
 */
import { rule, theme } from "../theme";

export interface SectionHeaderProps {
  readonly label: string;
  readonly width: number;
  readonly color?: string;
}

export const SectionHeader = ({ label, width, color = theme.muted }: SectionHeaderProps) => (
  <text>
    <span fg={color}>{`${label} `}</span>
    <span fg={theme.border}>{rule(width - label.length - 1)}</span>
  </text>
);
