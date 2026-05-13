import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	getSlackReconnectDelayMs,
	isSupportedSlackSocketEvent,
	shouldProcessSlackMessageId,
	slackMessageEventToInput,
} from "../src/live/slack.js";
import { getTriggerReplyToMessageId } from "../src/runtime.js";
import type { InboundMessageRecord, ResolvedConversation, SlackAccountConfig } from "../types.js";

function conversation(overrides: Partial<ResolvedConversation> = {}): ResolvedConversation {
	const account: SlackAccountConfig = {
		service: "slack",
		name: "Team Slack",
		botToken: "xoxb-test",
		appToken: "xapp-test",
		botUserId: "UBOT",
		botUsername: "pi",
		teamId: "T1",
		channels: {},
	};
	return {
		service: "slack",
		botName: "pi",
		accountId: "slack-team",
		account,
		channelKey: "general",
		channel: { id: "C1", name: "general" },
		conversationId: "slack-team/general",
		conversationName: "Team Slack / general",
		access: {},
		gondolinSecrets: {},
		accountDir: "/tmp/account",
		sharedDir: "/tmp/account/shared",
		conversationDir: "/tmp/channel",
		workspaceDir: "/tmp/channel/workspace",
		gondolinDir: "/tmp/channel/gondolin",
		accountMemoryPath: "/tmp/account/shared/memory.md",
		channelMemoryPath: "/tmp/channel/workspace/memory.md",
		logPath: "/tmp/channel/channel.jsonl",
		filesDir: "/tmp/channel/workspace/incoming",
		lockPath: "/tmp/channel/.lock",
		...overrides,
	};
}

test("Slack message events normalize to inbound input", async () => {
	const input = await slackMessageEventToInput(conversation(), {
		type: "message",
		channel: "C1",
		user: "U1",
		text: "<@UBOT> please check <https://example.com|this link>",
		ts: "1710000000.000100",
	});

	assert.deepEqual(input, {
		messageId: "1710000000.000100",
		userId: "U1",
		userName: undefined,
		text: "@UBOT please check this link (https://example.com)",
		mentionedBot: true,
		isBot: false,
		attachments: [],
	});
});

test("Slack socket mode accepts app mention events", () => {
	assert.equal(
		isSupportedSlackSocketEvent({
			type: "events_api",
			payload: { type: "event_callback", event: { type: "app_mention", channel: "C1", user: "U1", ts: "1" } },
		}),
		true,
	);
});

test("Slack message ids are deduplicated", () => {
	const seen = new Set<string>();

	assert.equal(shouldProcessSlackMessageId(seen, "1778673622.974879"), true);
	assert.equal(shouldProcessSlackMessageId(seen, "1778673622.974879"), false);
	assert.equal(shouldProcessSlackMessageId(seen, "1778673641.708009"), true);
});

test("Slack reconnect backoff increases and caps", () => {
	assert.equal(getSlackReconnectDelayMs(0), 1000);
	assert.equal(getSlackReconnectDelayMs(1), 2000);
	assert.equal(getSlackReconnectDelayMs(5), 30000);
	assert.equal(getSlackReconnectDelayMs(20), 30000);
});

test("Slack preserve reply mode only replies in existing threads", () => {
	const topLevel = inboundRecord({ messageId: "100.1" });
	const threaded = inboundRecord({ messageId: "101.1", threadId: "100.1" });

	assert.equal(
		getTriggerReplyToMessageId(conversation({ channel: { id: "C1", slack: { replyMode: "preserve" } } }), topLevel),
		undefined,
	);
	assert.equal(
		getTriggerReplyToMessageId(conversation({ channel: { id: "C1", slack: { replyMode: "preserve" } } }), threaded),
		"100.1",
	);
});

test("Slack reply modes can force thread or channel replies", () => {
	const record = inboundRecord({ messageId: "100.1", threadId: "99.1" });

	assert.equal(
		getTriggerReplyToMessageId(conversation({ channel: { id: "C1", slack: { replyMode: "thread" } } }), record),
		"99.1",
	);
	assert.equal(
		getTriggerReplyToMessageId(conversation({ channel: { id: "C1", slack: { replyMode: "channel" } } }), record),
		undefined,
	);
	assert.equal(
		getTriggerReplyToMessageId(
			conversation({ channel: { id: "C1", slack: { replyMode: "thread" } } }),
			inboundRecord({ messageId: "100.1" }),
		),
		"100.1",
	);
});

function inboundRecord(overrides: Partial<InboundMessageRecord>): InboundMessageRecord {
	return {
		type: "inbound",
		recordId: 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		service: "slack",
		accountId: "slack-team",
		channelKey: "general",
		channelId: "C1",
		scope: "channel",
		messageId: "100.1",
		userId: "U1",
		text: "hi",
		mentionedBot: true,
		isBot: false,
		attachments: [],
		...overrides,
	};
}
