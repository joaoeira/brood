/**
 * Model-facing peer-communication vocabulary.
 *
 * This module owns the bounded wire shapes accepted and returned by Brood's
 * communication tools. It contains no registry state and performs no I/O.
 */
import { Effect, Schema, SchemaGetter } from "effect";
import {
  AgentName,
  BroodControl,
  ProfileName,
  type AgentId,
  type ToolInvocationId,
} from "./agent.js";

// These limits are protocol policy rather than operator configuration. Keep
// the matching TypeBox constraints in communication-tools.ts synchronized.
export const MAX_AGENT_PATH_CHARS = 8_192;
export const MAX_ACTIVITY_CHARS = 500;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_QUESTION_CHARS = 4_000;
export const MAX_REPLY_CHARS = 1_000;
export const MAX_BULLETIN_CHARS = 4_000;
export const MAX_UNREAD_MESSAGES_PER_AGENT = 100;
export const MAX_PENDING_OPERATOR_MESSAGES_PER_AGENT = 4;
export const MAX_INCOMING_REQUESTS_PER_AGENT = 16;
export const MAX_REQUEST_TARGETS_PER_WAIT = 4;
export const MAX_INBOX_READ_ITEMS = 8;
export const MAX_DIRECTORY_PAGE_ITEMS = 32;
export const MAX_BULLETINS_PER_AUTHOR = 8;
export const MAX_BULLETIN_READ_ITEMS = 8;
export const MAX_TOOL_RESULT_CHARS = 32_000;

const canonicalAgentPath = Schema.isPattern(/^root(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/);
const opaqueRequestId = Schema.isPattern(/^request_[A-Za-z0-9_-]+$/);
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

const isDirectionalControl = (codePoint: number): boolean =>
  codePoint === 0x061c ||
  codePoint === 0x200e ||
  codePoint === 0x200f ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069);

const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      isDirectionalControl(codePoint)
      ? " "
      : character;
  }).join("");

const normalizePeerBody = (value: string): string =>
  Array.from(value.replace(/\r\n?/gu, "\n"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "�";
    if (
      (codePoint <= 31 && codePoint !== 9 && codePoint !== 10) ||
      (codePoint >= 127 && codePoint <= 159) ||
      isDirectionalControl(codePoint)
    ) {
      return "";
    }
    return character;
  })
    .join("")
    .trim();

const normalizedBodyLength = (input: unknown, field: string): number | undefined => {
  if (typeof input !== "object" || input === null || !(field in input)) return undefined;
  const value = Reflect.get(input, field);
  return typeof value === "string" ? Array.from(normalizePeerBody(value)).length : undefined;
};

const codePointLimit = (maximum: number, label: string) =>
  Schema.makeFilter(
    (value: string) =>
      Array.from(value).length <= maximum
        ? undefined
        : `${label} must contain at most ${maximum} Unicode code points`,
    { expected: `${label} with at most ${maximum} Unicode code points` },
  );

const boundedBody = (maximum: number, label: string) =>
  Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform(normalizePeerBody),
      encode: SchemaGetter.transform(normalizePeerBody),
    }),
  ).check(Schema.isMinLength(1), codePointLimit(maximum, label));

export const normalizeActivity = (value: string): string =>
  replaceControlCharacters(value.replace(ansiEscape, "")).replace(/\s+/gu, " ").trim();

export const AgentPath = Schema.String.check(
  Schema.isMinLength(4),
  Schema.isMaxLength(MAX_AGENT_PATH_CHARS),
  canonicalAgentPath,
).pipe(Schema.brand("AgentPath"));
export type AgentPath = typeof AgentPath.Type;
export const makeAgentPath = Schema.decodeUnknownSync(AgentPath);
export const decodeAgentPath = Schema.decodeUnknownEffect(AgentPath);

export const RequestId = Schema.String.check(Schema.isMaxLength(80), opaqueRequestId).pipe(
  Schema.brand("RequestId"),
);
export type RequestId = typeof RequestId.Type;
export const makeRequestId = Schema.decodeUnknownSync(RequestId);
export const decodeRequestId = Schema.decodeUnknownEffect(RequestId);

export const AddressableAgentState = Schema.Literals(["queued", "starting", "running", "waiting"]);
export type AddressableAgentState = typeof AddressableAgentState.Type;

export const AgentActivity = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(normalizeActivity),
    encode: SchemaGetter.transform(normalizeActivity),
  }),
).check(Schema.isMinLength(1), codePointLimit(MAX_ACTIVITY_CHARS, "activity"));
export type AgentActivity = typeof AgentActivity.Type;

const MessageBody = boundedBody(MAX_MESSAGE_CHARS, "message");
const QuestionBody = boundedBody(MAX_QUESTION_CHARS, "question");
const ReplyBody = boundedBody(MAX_REPLY_CHARS, "reply");
const BulletinBody = boundedBody(MAX_BULLETIN_CHARS, "bulletin");

export const AgentWaitCounts = Schema.Struct({
  agentCompletions: Schema.Natural,
  replies: Schema.Natural,
});
export interface AgentWaitCounts extends Schema.Schema.Type<typeof AgentWaitCounts> {}

export const AgentDirectoryEntry = Schema.Struct({
  path: AgentPath,
  name: AgentName,
  state: AddressableAgentState,
  profile: ProfileName,
  activity: Schema.optionalKey(AgentActivity),
  waitingFor: AgentWaitCounts,
  waitingForCaller: Schema.Boolean,
});
export interface AgentDirectoryEntry extends Schema.Schema.Type<typeof AgentDirectoryEntry> {}

export const InboxMessage = Schema.Struct({
  kind: Schema.Literal("message"),
  from: AgentPath,
  message: MessageBody,
});
export interface InboxMessage extends Schema.Schema.Type<typeof InboxMessage> {}

export const InboxRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  request: RequestId,
  from: AgentPath,
  question: QuestionBody,
});
export interface InboxRequest extends Schema.Schema.Type<typeof InboxRequest> {}

export const InboxItem = Schema.Union([InboxMessage, InboxRequest]);
export type InboxItem = typeof InboxItem.Type;

/**
 * Operator messages never travel through the peer inbox. They are rendered by
 * Brood into a `<brood_operator_message>` block and injected directly into the
 * agent's conversation — steered mid-run, or embedded in the next command.
 * Peers cannot produce that block: peer-authored text is always escaped or
 * JSON-quoted wherever it is rendered, so a raw block can only come from Brood.
 */
export const OperatorMessageId = Schema.String.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^opmsg_[A-Za-z0-9-]+$/),
).pipe(Schema.brand("OperatorMessageId"));
export type OperatorMessageId = typeof OperatorMessageId.Type;
export const makeOperatorMessageId = Schema.decodeUnknownSync(OperatorMessageId);

/** Boundary decoder for operator-authored message bodies entering the registry. */
export const OperatorMessageBody = boundedBody(MAX_MESSAGE_CHARS, "operator message");
export const decodeOperatorMessageBody = Schema.decodeUnknownEffect(OperatorMessageBody);

export const InboxCounts = Schema.Struct({
  unreadMessages: Schema.Natural,
  openRequests: Schema.Natural,
  omittedFromPage: Schema.Natural,
});
export interface InboxCounts extends Schema.Schema.Type<typeof InboxCounts> {}

export const PeerRequestOutcome = Schema.TaggedUnion({
  Replied: {
    request: RequestId,
    to: AgentPath,
    reply: ReplyBody,
  },
  Unavailable: {
    request: RequestId,
    to: AgentPath,
    recipientState: Schema.Literals(["completed", "failed", "interrupted"]),
  },
});
export type PeerRequestOutcome = typeof PeerRequestOutcome.Type;

export const BulletinPost = Schema.Struct({
  author: AgentPath,
  message: BulletinBody,
});
export interface BulletinPost extends Schema.Schema.Type<typeof BulletinPost> {}

export const BulletinReadSummary = Schema.Struct({
  remaining: Schema.Natural,
});
export interface BulletinReadSummary extends Schema.Schema.Type<typeof BulletinReadSummary> {}

const InboxReadLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_INBOX_READ_ITEMS),
);
const BulletinReadLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_BULLETIN_READ_ITEMS),
);

export const ListAgentsInput = Schema.Struct({
  after: Schema.optionalKey(AgentPath),
});
export interface ListAgentsInput extends Schema.Schema.Type<typeof ListAgentsInput> {}

export const AgentSelf = Schema.Struct({
  path: AgentPath,
});
export interface AgentSelf extends Schema.Schema.Type<typeof AgentSelf> {}

export const ListAgentsResult = Schema.Struct({
  self: AgentSelf,
  agents: Schema.Array(AgentDirectoryEntry),
  nextAfter: Schema.optionalKey(AgentPath),
});
export interface ListAgentsResult extends Schema.Schema.Type<typeof ListAgentsResult> {}

export const SetActivityInput = Schema.Struct({
  activity: Schema.NullOr(AgentActivity),
});
export interface SetActivityInput extends Schema.Schema.Type<typeof SetActivityInput> {}

export const SetActivityResult = Schema.Struct({
  activity: Schema.optionalKey(AgentActivity),
});
export interface SetActivityResult extends Schema.Schema.Type<typeof SetActivityResult> {}

export const SendMessageInput = Schema.Struct({
  to: AgentPath,
  message: MessageBody,
  /** Wakes a parked recipient for one coalesced coordination turn. */
  urgent: Schema.optionalKey(Schema.Boolean),
});
export interface SendMessageInput extends Schema.Schema.Type<typeof SendMessageInput> {}

/** Recipient state in a send result. Terminal states are reachable: passive
 * mail to a finished agent is accepted and queued rather than rejected. */
export const RecipientAgentState = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
]);
export type RecipientAgentState = typeof RecipientAgentState.Type;

export const SendMessageResult = Schema.Struct({
  to: AgentPath,
  recipientState: RecipientAgentState,
  /** The recipient had finished; the message is retained in its inbox and will
   * be read only if the agent is later revived. */
  queuedForRevival: Schema.optionalKey(Schema.Boolean),
  /** This send revived a finished agent: it is being brought back to read it. */
  revived: Schema.optionalKey(Schema.Boolean),
});
export interface SendMessageResult extends Schema.Schema.Type<typeof SendMessageResult> {}

export const AskAgentInput = Schema.Struct({
  to: AgentPath,
  question: QuestionBody,
});
export interface AskAgentInput extends Schema.Schema.Type<typeof AskAgentInput> {}

export const AskAgentToolDetails = Schema.Struct({
  version: Schema.Literal(1),
  request: RequestId,
  to: AgentPath,
  recipientState: AddressableAgentState,
  /** This question revived a finished agent to answer it. */
  revived: Schema.optionalKey(Schema.Boolean),
  broodControl: BroodControl,
});
export interface AskAgentToolDetails extends Schema.Schema.Type<typeof AskAgentToolDetails> {}

export const ReadMessagesInput = Schema.Struct({
  limit: Schema.optionalKey(InboxReadLimit),
});
export interface ReadMessagesInput extends Schema.Schema.Type<typeof ReadMessagesInput> {}

export const ReadMessagesResult = Schema.Struct({
  items: Schema.Array(InboxItem),
  inbox: InboxCounts,
});
export interface ReadMessagesResult extends Schema.Schema.Type<typeof ReadMessagesResult> {}

export const ReplyToRequestInput = Schema.Struct({
  request: RequestId,
  message: ReplyBody,
});
export interface ReplyToRequestInput extends Schema.Schema.Type<typeof ReplyToRequestInput> {}

export const ReplyToRequestResult = Schema.Struct({
  request: RequestId,
  to: AgentPath,
});
export interface ReplyToRequestResult extends Schema.Schema.Type<typeof ReplyToRequestResult> {}

export const PostBulletinInput = Schema.Struct({
  message: BulletinBody,
});
export interface PostBulletinInput extends Schema.Schema.Type<typeof PostBulletinInput> {}

export const PostBulletinResult = Schema.Struct({
  author: AgentPath,
});
export interface PostBulletinResult extends Schema.Schema.Type<typeof PostBulletinResult> {}

export const ReadBulletinsInput = Schema.Struct({
  limit: Schema.optionalKey(BulletinReadLimit),
});
export interface ReadBulletinsInput extends Schema.Schema.Type<typeof ReadBulletinsInput> {}

export const ReadBulletinsResult = Schema.Struct({
  posts: Schema.Array(BulletinPost),
  bulletin: BulletinReadSummary,
});
export interface ReadBulletinsResult extends Schema.Schema.Type<typeof ReadBulletinsResult> {}

export class ListAgentsRejected extends Schema.TaggedError<ListAgentsRejected>()(
  "ListAgentsRejected",
  {
    reason: Schema.Literal("InvalidInput"),
    message: Schema.String,
  },
) {}

export class SetActivityRejected extends Schema.TaggedError<SetActivityRejected>()(
  "SetActivityRejected",
  {
    reason: Schema.Literals(["InvalidInput", "DuplicateInvocationId"]),
    message: Schema.String,
  },
) {}

export class SendMessageRejected extends Schema.TaggedError<SendMessageRejected>()(
  "SendMessageRejected",
  {
    reason: Schema.Literals([
      "InvalidInput",
      "UnknownRecipient",
      "RecipientTerminal",
      "SelfRecipient",
      "RecipientMessageCapacityExceeded",
      "DuplicateInvocationId",
    ]),
    recipient: Schema.optionalKey(Schema.String),
    message: Schema.String,
  },
) {}

export class AskAgentRejected extends Schema.TaggedError<AskAgentRejected>()("AskAgentRejected", {
  reason: Schema.Literals([
    "InvalidInput",
    "UnknownRecipient",
    "RecipientTerminal",
    "SelfRecipient",
    "RecipientRequestCapacityExceeded",
    "RequestWaitLimitExceeded",
    "DuplicateInvocationId",
  ]),
  recipient: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export class ReadMessagesRejected extends Schema.TaggedError<ReadMessagesRejected>()(
  "ReadMessagesRejected",
  {
    reason: Schema.Literals(["InvalidInput", "InvalidLimit", "DuplicateInvocationId"]),
    message: Schema.String,
  },
) {}

export class ReplyRejected extends Schema.TaggedError<ReplyRejected>()("ReplyRejected", {
  reason: Schema.Literals([
    "InvalidInput",
    "UnknownOrClosedRequest",
    "NotRecipient",
    "AlreadyReplied",
    "DuplicateInvocationId",
  ]),
  request: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export class PostBulletinRejected extends Schema.TaggedError<PostBulletinRejected>()(
  "PostBulletinRejected",
  {
    reason: Schema.Literals(["InvalidInput", "DuplicateInvocationId"]),
    message: Schema.String,
  },
) {}

export class ReadBulletinsRejected extends Schema.TaggedError<ReadBulletinsRejected>()(
  "ReadBulletinsRejected",
  {
    reason: Schema.Literals(["InvalidInput", "InvalidLimit", "DuplicateInvocationId"]),
    message: Schema.String,
  },
) {}

const strict = { onExcessProperty: "error" as const };

export const decodeListAgentsInput = Effect.fn("Brood.Communication.decodeListAgentsInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      ListAgentsInput,
      strict,
    )(input).pipe(
      Effect.mapError(
        () =>
          new ListAgentsRejected({
            reason: "InvalidInput",
            message:
              "Invalid list_agents input. Provide only an optional canonical `after` path returned by an earlier list_agents call.",
          }),
      ),
    );
  },
);

export const decodeSetActivityInput = Effect.fn("Brood.Communication.decodeSetActivityInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      SetActivityInput,
      strict,
    )(input).pipe(
      Effect.mapError(
        () =>
          new SetActivityRejected({
            reason: "InvalidInput",
            message: `Invalid set_activity input. Supply null to clear the activity or one nonblank line of at most ${MAX_ACTIVITY_CHARS} Unicode code points.`,
          }),
      ),
    );
  },
);

export const decodeSendMessageInput = Effect.fn("Brood.Communication.decodeSendMessageInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      SendMessageInput,
      strict,
    )(input).pipe(
      Effect.mapError(
        () =>
          new SendMessageRejected({
            reason: "InvalidInput",
            message: `Invalid send_message input. Supply a canonical recipient path and a nonblank message of at most ${MAX_MESSAGE_CHARS} Unicode code points.`,
          }),
      ),
    );
  },
);

export const decodeAskAgentInput = Effect.fn("Brood.Communication.decodeAskAgentInput")(function* (
  input: unknown,
) {
  return yield* Schema.decodeUnknownEffect(
    AskAgentInput,
    strict,
  )(input).pipe(
    Effect.mapError(
      () =>
        new AskAgentRejected({
          reason: "InvalidInput",
          message: `Invalid ask_agent input. Supply a canonical recipient path and a nonblank question of at most ${MAX_QUESTION_CHARS} Unicode code points.`,
        }),
    ),
  );
});

const hasOnlyLimit = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "limit" in input &&
  Object.keys(input).every((key) => key === "limit");

export const decodeReadMessagesInput = Effect.fn("Brood.Communication.decodeReadMessagesInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      ReadMessagesInput,
      strict,
    )(input).pipe(
      Effect.mapError(
        () =>
          new ReadMessagesRejected({
            reason: hasOnlyLimit(input) ? "InvalidLimit" : "InvalidInput",
            message: hasOnlyLimit(input)
              ? `Invalid read_messages limit. Supply an integer between 1 and ${MAX_INBOX_READ_ITEMS}.`
              : "Invalid read_messages input. Supply only the optional `limit` field.",
          }),
      ),
    );
  },
);

export const decodeReplyToRequestInput = Effect.fn("Brood.Communication.decodeReplyToRequestInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      ReplyToRequestInput,
      strict,
    )(input).pipe(
      Effect.mapError(() => {
        const length = normalizedBodyLength(input, "message");
        return new ReplyRejected({
          reason: "InvalidInput",
          message:
            length !== undefined && length > MAX_REPLY_CHARS
              ? `The reply contains ${length} Unicode code points; the maximum is ${MAX_REPLY_CHARS}. Put the full answer under \`.brood/shared/\` and reply with a summary and path.`
              : `Invalid reply_to_request input. Supply the exact request ID and a nonblank reply of at most ${MAX_REPLY_CHARS} Unicode code points; put longer material under .brood/shared/ and reply with its path.`,
        });
      }),
    );
  },
);

export const decodePostBulletinInput = Effect.fn("Brood.Communication.decodePostBulletinInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      PostBulletinInput,
      strict,
    )(input).pipe(
      Effect.mapError(() => {
        const length = normalizedBodyLength(input, "message");
        return new PostBulletinRejected({
          reason: "InvalidInput",
          message:
            length !== undefined && length > MAX_BULLETIN_CHARS
              ? `The bulletin contains ${length} Unicode code points; the maximum is ${MAX_BULLETIN_CHARS}. Put the full material under \`.brood/shared/\` and post a short description with its path.`
              : `Invalid post_bulletin input. Supply a nonblank post of at most ${MAX_BULLETIN_CHARS} Unicode code points; put longer material under .brood/shared/ and post its path.`,
        });
      }),
    );
  },
);

export const decodeReadBulletinsInput = Effect.fn("Brood.Communication.decodeReadBulletinsInput")(
  function* (input: unknown) {
    return yield* Schema.decodeUnknownEffect(
      ReadBulletinsInput,
      strict,
    )(input).pipe(
      Effect.mapError(
        () =>
          new ReadBulletinsRejected({
            reason: hasOnlyLimit(input) ? "InvalidLimit" : "InvalidInput",
            message: hasOnlyLimit(input)
              ? `Invalid read_bulletins limit. Supply an integer between 1 and ${MAX_BULLETIN_READ_ITEMS}.`
              : "Invalid read_bulletins input. Supply only the optional `limit` field.",
          }),
      ),
    );
  },
);

/** Caller-bound implementation surface supplied by the supervisor. */
export interface CommunicationToolPort {
  readonly listAgents: (
    callerId: AgentId,
    input: ListAgentsInput,
  ) => Effect.Effect<ListAgentsResult, ListAgentsRejected>;
  readonly setActivity: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SetActivityInput,
  ) => Effect.Effect<SetActivityResult, SetActivityRejected>;
  readonly sendMessage: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: SendMessageInput,
  ) => Effect.Effect<SendMessageResult, SendMessageRejected>;
  readonly askAgent: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: AskAgentInput,
  ) => Effect.Effect<AskAgentToolDetails, AskAgentRejected>;
  readonly readMessages: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadMessagesInput,
  ) => Effect.Effect<ReadMessagesResult, ReadMessagesRejected>;
  readonly replyToRequest: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReplyToRequestInput,
  ) => Effect.Effect<ReplyToRequestResult, ReplyRejected>;
  readonly postBulletin: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: PostBulletinInput,
  ) => Effect.Effect<PostBulletinResult, PostBulletinRejected>;
  readonly readBulletins: (
    callerId: AgentId,
    invocationId: ToolInvocationId,
    input: ReadBulletinsInput,
  ) => Effect.Effect<ReadBulletinsResult, ReadBulletinsRejected>;
}
