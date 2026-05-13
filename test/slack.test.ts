import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ResolvedConversation, SlackAccountConfig } from "../src/core/config-types.js";
import { isSupportedSlackSocketEvent, slackMessageEventToInput } from "../src/live/slack.js";

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
