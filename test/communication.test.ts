import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  AgentPath,
  AgentActivity,
  AgentDirectoryEntry,
  MAX_ACTIVITY_CHARS,
  MAX_BULLETIN_CHARS,
  MAX_INBOX_READ_ITEMS,
  MAX_MESSAGE_CHARS,
  MAX_QUESTION_CHARS,
  MAX_REPLY_CHARS,
  PeerRequestOutcome,
  RequestId,
  SendMessageRejected,
  decodeAskAgentInput,
  decodeListAgentsInput,
  decodePostBulletinInput,
  decodeReadBulletinsInput,
  decodeReadMessagesInput,
  decodeReplyToRequestInput,
  decodeSendMessageInput,
  decodeSetActivityInput,
  makeAgentPath,
  makeRequestId,
} from "../src/communication.js";

const repeated = (value: string, count: number): string => value.repeat(count);

describe("communication vocabulary", () => {
  it("round-trips canonical paths and opaque request IDs", () => {
    expect(makeAgentPath("root/research/deep-dive")).toBe("root/research/deep-dive");
    expect(makeRequestId("request_abc-123")).toBe("request_abc-123");
    expect(() => Schema.decodeUnknownSync(AgentPath)("research")).toThrow("Expected");
    expect(() => Schema.decodeUnknownSync(AgentPath)("root/bad name")).toThrow("Expected");
    expect(() => Schema.decodeUnknownSync(RequestId)("agent_123")).toThrow("Expected");
  });

  it.effect("strictly rejects excess properties on every input boundary", () =>
    Effect.gen(function* () {
      const exits = [
        yield* Effect.exit(decodeListAgentsInput({ unexpected: true })),
        yield* Effect.exit(decodeSetActivityInput({ activity: null, unexpected: true })),
        yield* Effect.exit(
          decodeSendMessageInput({ to: "root/peer", message: "hello", unexpected: true }),
        ),
        yield* Effect.exit(
          decodeAskAgentInput({ to: "root/peer", question: "help?", unexpected: true }),
        ),
        yield* Effect.exit(decodeReadMessagesInput({ unexpected: true })),
        yield* Effect.exit(
          decodeReplyToRequestInput({
            request: "request_1",
            message: "answer",
            unexpected: true,
          }),
        ),
        yield* Effect.exit(decodePostBulletinInput({ message: "finding", unexpected: true })),
        yield* Effect.exit(decodeReadBulletinsInput({ unexpected: true })),
      ];
      expect(exits.every((exit) => exit._tag === "Failure")).toBe(true);
    }),
  );

  it.effect("normalizes and bounds bodies by Unicode code point", () =>
    Effect.gen(function* () {
      const message = yield* decodeSendMessageInput({
        to: "root/peer",
        message: `  ${repeated("😀", MAX_MESSAGE_CHARS)}  `,
      });
      expect(Array.from(message.message)).toHaveLength(MAX_MESSAGE_CHARS);

      const question = yield* decodeAskAgentInput({
        to: "root/peer",
        question: repeated("q", MAX_QUESTION_CHARS),
      });
      expect(question.question).toHaveLength(MAX_QUESTION_CHARS);

      const bulletin = yield* decodePostBulletinInput({
        message: repeated("b", MAX_BULLETIN_CHARS),
      });
      expect(bulletin.message).toHaveLength(MAX_BULLETIN_CHARS);

      const tooLong = yield* Effect.exit(
        decodeReplyToRequestInput({
          request: "request_1",
          message: repeated("😀", MAX_REPLY_CHARS + 1),
        }),
      );
      expect(tooLong._tag).toBe("Failure");

      const safe = yield* decodeSendMessageInput({
        to: "root/peer",
        message: "line one\u0000\nline two\ud800\u202Espoof",
      });
      expect(safe.message).toBe("line one\nline two�spoof");
    }),
  );

  it.effect("reports exact oversize reply and bulletin counts with the shared-dir recovery", () =>
    Effect.gen(function* () {
      const reply = yield* Effect.flip(
        decodeReplyToRequestInput({
          request: "request_1",
          message: repeated("😀", MAX_REPLY_CHARS + 1),
        }),
      );
      const bulletin = yield* Effect.flip(
        decodePostBulletinInput({ message: repeated("b", MAX_BULLETIN_CHARS + 1) }),
      );

      expect(reply.message).toBe(
        `The reply contains ${MAX_REPLY_CHARS + 1} Unicode code points; the maximum is ${MAX_REPLY_CHARS}. Put the full answer under \`.brood/shared/\` and reply with a summary and path.`,
      );
      expect(bulletin.message).toBe(
        `The bulletin contains ${MAX_BULLETIN_CHARS + 1} Unicode code points; the maximum is ${MAX_BULLETIN_CHARS}. Put the full material under \`.brood/shared/\` and post a short description with its path.`,
      );
    }),
  );

  it.effect("turns activity into one inert display line and supports clearing it", () =>
    Effect.gen(function* () {
      const set = yield* decodeSetActivityInput({
        activity: "  checking\u001b[31m Pi\u001b[0m\n\t stop hook  ",
      });
      expect(set).toEqual({ activity: "checking Pi stop hook" });
      expect(yield* decodeSetActivityInput({ activity: "safe\u202Etxt" })).toEqual({
        activity: "safe txt",
      });
      expect(yield* decodeSetActivityInput({ activity: null })).toEqual({ activity: null });

      const blank = yield* Effect.exit(decodeSetActivityInput({ activity: "\u001b[31m\n\t" }));
      const oversized = yield* Effect.exit(
        decodeSetActivityInput({ activity: repeated("x", MAX_ACTIVITY_CHARS + 1) }),
      );
      expect(blank._tag).toBe("Failure");
      expect(oversized._tag).toBe("Failure");
    }),
  );

  it("exports the same bounded activity schema for monitoring projections", () => {
    expect(
      Schema.decodeUnknownSync(AgentActivity)("  implementing\u001b[31m registry\u001b[0m\n now "),
    ).toBe("implementing registry now");
    expect(() =>
      Schema.decodeUnknownSync(AgentActivity)(repeated("x", MAX_ACTIVITY_CHARS + 1)),
    ).toThrow("at most 500 Unicode code points");
  });

  it("keeps the recipient path in every correlated request outcome", () => {
    expect(
      Schema.decodeUnknownSync(PeerRequestOutcome)({
        _tag: "Replied",
        request: "request_1",
        to: "root/research",
        reply: "use the stable hook",
      }),
    ).toEqual({
      _tag: "Replied",
      request: makeRequestId("request_1"),
      to: makeAgentPath("root/research"),
      reply: "use the stable hook",
    });
    expect(
      Schema.decodeUnknownSync(PeerRequestOutcome)({
        _tag: "Unavailable",
        request: "request_2",
        to: "root/research",
        recipientState: "failed",
      }).to,
    ).toBe(makeAgentPath("root/research"));
  });

  it("keeps directory rows fixed-size and path-addressable", () => {
    expect(
      Schema.decodeUnknownSync(AgentDirectoryEntry, { onExcessProperty: "error" })({
        path: "root/research",
        name: "research",
        state: "waiting",
        profile: "worker",
        waitingFor: { agentCompletions: 12, replies: 2 },
        waitingForCaller: true,
      }),
    ).toMatchObject({
      path: makeAgentPath("root/research"),
      waitingFor: { agentCompletions: 12, replies: 2 },
      waitingForCaller: true,
    });
  });

  it.effect("rejects invalid read limits with the operation-specific reason", () =>
    Effect.gen(function* () {
      const messages = yield* Effect.flip(
        decodeReadMessagesInput({ limit: MAX_INBOX_READ_ITEMS + 1 }),
      );
      const bulletins = yield* Effect.flip(decodeReadBulletinsInput({ limit: 0 }));
      expect(messages.reason).toBe("InvalidLimit");
      expect(bulletins.reason).toBe("InvalidLimit");
      expect(messages.message).toContain(`between 1 and ${MAX_INBOX_READ_ITEMS}`);

      const excess = yield* Effect.flip(decodeReadMessagesInput({ limit: 1, unexpected: true }));
      expect(excess.reason).toBe("InvalidInput");
    }),
  );

  it("makes domain rejection messages complete and actionable", () => {
    const rejection = new SendMessageRejected({
      reason: "RecipientTerminal",
      recipient: "root/api",
      message:
        "`root/api` has completed and cannot receive new messages. Choose an addressable agent from `list_agents` or write durable context under `.brood/shared/`.",
    });
    expect(rejection.message).toMatch(/\.$/);
    expect(rejection.message).toContain("list_agents");
  });
});
