/**
 * Everything a model reads from Brood: deterministic text normalization,
 * code-point truncation, and the versioned resume envelope.
 *
 * All limits count Unicode code points. Peer output is escaped so a child's
 * text can never forge envelope structure, and no dependency is ever dropped
 * from a resume payload — bodies shrink before headers do.
 */
import type {
  AgentAdmissionCapacity,
  AgentCommand,
  AgentFailure,
  AgentFailureSummary,
  AgentId,
  AgentName,
  AgentOutcome,
  AgentResult,
  DependencyOutcome,
  InterruptReason,
} from "./agent.js";

export const TRUNCATION_SENTINEL = "\n[truncated by Brood]";
export const MIN_BOUNDED_TEXT_CHARS = Array.from(TRUNCATION_SENTINEL).length;
export const DEFAULT_MAX_FAILURE_MESSAGE_CHARS = 2_000;

export const codePointLength = (value: string): number => Array.from(value).length;

export const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    /* oxlint-disable-next-line no-control-regex -- remove unsafe control text at a trust boundary. */
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

interface BudgetSelection {
  readonly prefixLength: number;
  readonly totalCost: number;
}

const truncateToBudget = (
  points: ReadonlyArray<string>,
  costOf: (point: string) => number,
  budget: number,
): BudgetSelection => {
  let prefixLength = 0;
  let prefixCost = 0;
  let totalCost = 0;
  let acceptingPrefix = true;
  for (const point of points) {
    const cost = costOf(point);
    totalCost += cost;
    if (acceptingPrefix && prefixCost + cost <= budget) {
      prefixCost += cost;
      prefixLength += 1;
    } else {
      acceptingPrefix = false;
    }
  }
  return { prefixLength, totalCost };
};

const truncateCodePoints = (
  value: string,
  maxCodePoints: number,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalCharacterCount: number;
} => {
  const points = Array.from(value);
  const sentinel = Array.from(TRUNCATION_SENTINEL);
  const selection = truncateToBudget(points, () => 1, Math.max(0, maxCodePoints - sentinel.length));
  if (selection.totalCost <= maxCodePoints) {
    return { text: value, truncated: false, originalCharacterCount: points.length };
  }
  return {
    text: [...points.slice(0, selection.prefixLength), ...sentinel.slice(0, maxCodePoints)]
      .slice(0, maxCodePoints)
      .join(""),
    truncated: true,
    originalCharacterCount: points.length,
  };
};

export const normalizeAgentResult = (
  agentId: AgentId,
  sessionId: string,
  finalText: string,
  maxAgentResultChars: number,
): AgentResult => {
  const normalized = normalizeText(finalText);
  const summary = truncateCodePoints(normalized, maxAgentResultChars);
  return {
    agentId,
    sessionId,
    summary: summary.text,
    truncated: summary.truncated,
    originalCharacterCount: summary.originalCharacterCount,
  };
};

const failureText = (failure: AgentFailure): string => {
  switch (failure._tag) {
    case "AgentStartFailed":
    case "AgentRunFailed":
    case "AgentProtocolFailed":
      return failure.error.message;
    case "AgentDefect":
      return "The agent controller failed unexpectedly. Inspect supervisor logs for the internal cause.";
  }
};

export const summarizeAgentFailure = (
  failure: AgentFailure,
  maxFailureMessageChars: number,
): AgentFailureSummary => ({
  code: failure._tag,
  message: truncateCodePoints(normalizeText(failureText(failure)), maxFailureMessageChars).text,
});

const interruptCode = (reason: InterruptReason): string => reason._tag;

export const dependencyOutcomeFromAgent = (
  agentId: AgentId,
  name: AgentName,
  outcome: AgentOutcome,
  maxFailureMessageChars: number,
): DependencyOutcome => {
  switch (outcome._tag) {
    case "Completed":
      return { _tag: "Completed", agentId, name, result: outcome.result };
    case "Failed": {
      const failure = summarizeAgentFailure(outcome.failure, maxFailureMessageChars);
      return { _tag: "Failed", agentId, name, code: failure.code, message: failure.message };
    }
    case "Interrupted":
      return { _tag: "Interrupted", agentId, name, reason: interruptCode(outcome.reason) };
  }
};

const escapeXmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Runtime envelope and run instructions ───────────────────────────────────
// The envelope wording is part of the behavior: it must state that the pool is
// global, consumption is irreversible, unused capacity has option value, and a
// snapshot reserves nothing. Tests assert on this exact text.

export const renderRuntimeEnvelope = (capacity: AgentAdmissionCapacity): string =>
  [
    '<brood_runtime version="1">',
    `  <agent_admissions limit="${capacity.limit}" used="${capacity.used}" remaining="${capacity.remaining}" />`,
    "  <admission_semantics>",
    "    Admissions are shared by the entire swarm and never replenish.",
    "    The admission limit is a safety ceiling, not a target.",
    "    Unused admissions preserve options for later discoveries.",
    "    Remaining capacity can only decrease after this snapshot.",
    "    Only a successful delegate call commits admissions.",
    "  </admission_semantics>",
    "</brood_runtime>",
  ].join("\n");

const ENVELOPE_SEPARATOR = "\n\n";

// Worst-case prefix size, derived from the real renderer so the bound and the
// text cannot drift apart. Capacity values are safe integers by schema.
export const MAX_RUNTIME_ENVELOPE_CHARS = codePointLength(
  renderRuntimeEnvelope({
    limit: Number.MAX_SAFE_INTEGER,
    used: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
  }) + ENVELOPE_SEPARATOR,
);

export const minimumResumePromptChars = (maxAgentAdmissions: number): number =>
  512 + maxAgentAdmissions * 320 + MAX_RUNTIME_ENVELOPE_CHARS;

/** One agent-facing prompt: fresh capacity envelope, then the rendered command.
 * On a resume the envelope counts toward `maxResumePromptChars` and the
 * dependency bodies shrink before it does; an initial goal is not budgeted
 * here. The envelope is never truncated independently because that could
 * separate the numbers from their semantics. */
export const renderAgentPrompt = (
  command: AgentCommand,
  capacity: AgentAdmissionCapacity,
  maxResumePromptChars: number,
): string => {
  const prefix = `${renderRuntimeEnvelope(capacity)}${ENVELOPE_SEPARATOR}`;
  return `${prefix}${renderAgentCommand(command, maxResumePromptChars - codePointLength(prefix))}`;
};

export const renderRunInstructions = (instructions: string): string =>
  [
    "<brood_run_instructions>",
    // normalizeText is idempotent defense in depth, matching the goal path.
    escapeXmlText(normalizeText(instructions)),
    "</brood_run_instructions>",
  ].join("\n");

const escapeXmlAttribute = (value: string): string =>
  escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const escapeXmlTextWithin = (value: string, maximum: number): string => {
  const points = Array.from(value);
  const sentinelLength = codePointLength(TRUNCATION_SENTINEL);
  const selection = truncateToBudget(
    points,
    (point) => codePointLength(escapeXmlText(point)),
    Math.max(0, maximum - sentinelLength),
  );
  if (selection.totalCost <= maximum) return points.map(escapeXmlText).join("");
  if (maximum < sentinelLength) {
    throw new RangeError("Resume body budget cannot fit the truncation sentinel");
  }
  const encodedPrefix = points.slice(0, selection.prefixLength).map(escapeXmlText).join("");
  return `${encodedPrefix}${TRUNCATION_SENTINEL}`;
};

interface RenderedDependency {
  readonly header: string;
  readonly body: string;
  readonly footer: string;
}

const renderDependency = (outcome: DependencyOutcome): RenderedDependency => {
  switch (outcome._tag) {
    case "Completed":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="completed" truncated="${outcome.result.truncated}" original_characters="${outcome.result.originalCharacterCount}">`,
        body: outcome.result.summary,
        footer: "  </agent>",
      };
    case "Failed":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="failed" code="${escapeXmlAttribute(outcome.code)}">`,
        body: normalizeText(outcome.message),
        footer: "  </agent>",
      };
    case "Interrupted":
      return {
        header: `  <agent id="${escapeXmlAttribute(outcome.agentId)}" name="${escapeXmlAttribute(outcome.name)}" status="interrupted" reason="${escapeXmlAttribute(outcome.reason)}">`,
        body: "The agent was interrupted before producing a result.",
        footer: "  </agent>",
      };
  }
};

export const renderAgentCommand = (command: AgentCommand, maxResumePromptChars: number): string => {
  if (command._tag === "InitialGoal") return normalizeText(command.goal);

  const opening = `<brood_dependency_outcomes version="1" wait_id="${escapeXmlAttribute(command.waitId)}">`;
  const closing = [
    "</brood_dependency_outcomes>",
    "",
    "Continue the original goal using these dependency outcomes. Detailed work may be available at the workspace paths named in the summaries.",
  ].join("\n");
  const dependencies = command.outcomes.map(renderDependency);
  const fixedLength = codePointLength(
    [opening, ...dependencies.flatMap(({ header, footer }) => [header, footer]), closing].join(
      "\n",
    ),
  );
  const bodySeparators = dependencies.length;
  if (fixedLength + bodySeparators > maxResumePromptChars) {
    throw new RangeError(
      `maxResumePromptChars=${maxResumePromptChars} cannot preserve every dependency header`,
    );
  }
  let remaining = maxResumePromptChars - fixedLength - bodySeparators;
  const rendered: string[] = [opening];
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency === undefined) continue;
    const entriesLeft = dependencies.length - index;
    const allowance = Math.floor(remaining / entriesLeft);
    const body = escapeXmlTextWithin(dependency.body, allowance);
    remaining -= codePointLength(body);
    rendered.push(dependency.header, body, dependency.footer);
  }
  rendered.push(closing);
  return rendered.join("\n");
};
