import { Schema } from "effect";

/**
 * Turns a Pi session `.jsonl` file into flat, render-ready transcript entries.
 *
 * The file is untrusted input from another process's writer: lines can be
 * partial mid-write, and a session can legally contain entry types this viewer
 * knows nothing about. Every step here is therefore lenient — an unparseable
 * or unrecognised line is skipped, never fatal — matching Pi's own reader.
 */

export interface TranscriptHeader {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly cwd: string;
}

export type TranscriptEntry =
  | {
      readonly kind: "user";
      readonly at: number;
      readonly text: string;
      /** Set when the prompt is a Brood XML envelope rather than operator prose. */
      readonly envelope?: string;
    }
  | {
      readonly kind: "assistant";
      readonly at: number;
      readonly text: string;
      readonly stopReason: string;
    }
  | {
      readonly kind: "tool";
      readonly at: number;
      readonly toolName: string;
      readonly argsPreview: string;
      readonly ok?: boolean;
      readonly resultPreview?: string;
      /** Brood encodes agent suspension inside a control tool's result details. */
      readonly suspended?: boolean;
    }
  | { readonly kind: "compaction"; readonly at: number; readonly summary: string };

export interface Transcript {
  readonly header?: TranscriptHeader;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

const ARGS_PREVIEW_CHARS = 80;
const RESULT_PREVIEW_CHARS = 100;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
type JsonObject = typeof JsonObject.Type;

const isJsonObject = Schema.is(JsonObject);
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);

const asString = (value: Schema.Json | undefined): string | undefined =>
  value !== undefined && isString(value) ? value : undefined;

const asNumber = (value: Schema.Json | undefined): number | undefined =>
  value !== undefined && isNumber(value) && Number.isFinite(value) ? value : undefined;

/** Flattens a Pi content array (or bare string) down to its text blocks. */
const contentText = (content: Schema.Json | undefined): string => {
  if (content !== undefined && isString(content)) return content;
  if (!Array.isArray(content)) return "";
  const parts: Array<string> = [];
  for (const block of content) {
    if (!isJsonObject(block)) continue;
    if (block["type"] === "text") {
      const text = asString(block["text"]);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join("\n");
};

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Schema.Json | undefined;
}

const toolCalls = (content: Schema.Json | undefined): ReadonlyArray<ToolCall> => {
  if (!Array.isArray(content)) return [];
  const calls: Array<ToolCall> = [];
  for (const block of content) {
    if (!isJsonObject(block) || block["type"] !== "toolCall") continue;
    const id = asString(block["id"]);
    if (id === undefined) continue;
    calls.push({ id, name: asString(block["name"]) ?? "tool", args: block["arguments"] });
  }
  return calls;
};

/**
 * Brood wraps machine-generated prompts in `<brood_*>` elements. Rendering the
 * whole envelope drowns the transcript, so we collapse it to its element name
 * and size. Deliberately a first-token match: this is a display hint, not a
 * parser, and a real XML parse would buy nothing.
 */
export const summarizeEnvelope = (text: string): string | undefined => {
  const first = text.trimStart();
  const match = /^<(brood_[a-z_]+)/.exec(first);
  if (match === null) return undefined;
  const lineCount = text.split("\n").length;
  return `<${match[1]}> · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
};

const preview = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

const argsPreview = (args: Schema.Json | undefined): string => {
  if (args === undefined) return "";
  try {
    return preview(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
  } catch {
    return "";
  }
};

const isSuspendResult = (details: Schema.Json | undefined): boolean =>
  details !== undefined &&
  isJsonObject(details) &&
  isJsonObject(details["broodControl"]) &&
  details["broodControl"]["kind"] === "suspend";

const parseHeader = (line: JsonObject): TranscriptHeader => ({
  sessionId: asString(line["id"]) ?? "",
  timestamp: asString(line["timestamp"]) ?? "",
  cwd: asString(line["cwd"]) ?? "",
});

export const parseTranscript = (text: string): Transcript => {
  let header: TranscriptHeader | undefined;
  const entries: Array<TranscriptEntry> = [];
  // Tool calls are announced by an assistant turn and resolved by a later
  // toolResult line, so pending rows are patched in place once the result lands.
  const pendingToolRows = new Map<string, number>();

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") continue;
    let parsed: Schema.Json;
    try {
      parsed = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(rawLine));
    } catch {
      continue;
    }
    if (!isJsonObject(parsed)) continue;
    const line = parsed;

    const entryTime = Date.parse(asString(line["timestamp"]) ?? "");
    const fallbackTime = Number.isNaN(entryTime) ? 0 : entryTime;

    if (line["type"] === "session") {
      header = parseHeader(line);
      continue;
    }
    if (line["type"] === "compaction") {
      entries.push({
        kind: "compaction",
        at: fallbackTime,
        summary: asString(line["summary"]) ?? "",
      });
      continue;
    }
    if (line["type"] !== "message") continue;

    const message = line["message"];
    if (!isJsonObject(message)) continue;
    const at = asNumber(message["timestamp"]) ?? fallbackTime;

    if (message["role"] === "user") {
      const body = contentText(message["content"]);
      const envelope = summarizeEnvelope(body);
      const entry: TranscriptEntry = {
        kind: "user",
        at,
        text: body,
      };
      if (envelope !== undefined) Object.assign(entry, { envelope });
      entries.push(entry);
      continue;
    }

    if (message["role"] === "assistant") {
      const body = contentText(message["content"]);
      if (body.trim() !== "") {
        entries.push({
          kind: "assistant",
          at,
          text: body,
          stopReason: asString(message["stopReason"]) ?? "stop",
        });
      }
      for (const call of toolCalls(message["content"])) {
        pendingToolRows.set(call.id, entries.length);
        entries.push({
          kind: "tool",
          at,
          toolName: call.name,
          argsPreview: argsPreview(call.args),
        });
      }
      continue;
    }

    if (message["role"] === "toolResult") {
      const toolCallId = asString(message["toolCallId"]);
      const resultText = preview(contentText(message["content"]), RESULT_PREVIEW_CHARS);
      const ok = message["isError"] !== true;
      const suspended = isSuspendResult(message["details"]);
      const rowIndex = toolCallId === undefined ? undefined : pendingToolRows.get(toolCallId);
      const existing = rowIndex === undefined ? undefined : entries[rowIndex];
      if (rowIndex !== undefined && existing !== undefined && existing.kind === "tool") {
        const resolved: TranscriptEntry = {
          ...existing,
          ok,
          resultPreview: resultText,
        };
        if (suspended) Object.assign(resolved, { suspended: true });
        entries[rowIndex] = resolved;
        if (toolCallId !== undefined) pendingToolRows.delete(toolCallId);
        continue;
      }
      // Orphan result — the calling turn was compacted away or the file was
      // truncated. Still worth showing, just without its arguments.
      const orphan: TranscriptEntry = {
        kind: "tool",
        at,
        toolName: asString(message["toolName"]) ?? "tool",
        argsPreview: "",
        ok,
        resultPreview: resultText,
      };
      if (suspended) Object.assign(orphan, { suspended: true });
      entries.push(orphan);
    }
  }

  const transcript: Transcript = { entries };
  if (header !== undefined) Object.assign(transcript, { header });
  return transcript;
};
