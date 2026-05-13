import type { SlackAccountConfig } from "../core/config-types.js";
import type { AccountValidationResult, DiscoverySnapshot } from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

interface SlackApiResponse<_T> {
	ok: boolean;
	error?: string;
	user_id?: string;
	user?: string;
	team_id?: string;
	team?: string;
	team_name?: string;
	channels?: SlackConversation[];
	members?: SlackUser[];
	response_metadata?: { next_cursor?: string; warnings?: string[] };
	profile?: SlackUserProfile;
	is_bot?: boolean;
	bot_id?: string;
	name?: string;
}

interface SlackConversation {
	id: string;
	name?: string;
	is_im?: boolean;
	is_channel?: boolean;
	is_group?: boolean;
	is_mpim?: boolean;
}

interface SlackUserProfile {
	display_name?: string;
	real_name?: string;
}

interface SlackUser {
	id: string;
	name?: string;
	real_name?: string;
	is_bot?: boolean;
	profile?: SlackUserProfile;
}

async function callSlack<T>(
	token: string,
	method: string,
	body: Record<string, unknown> = {},
): Promise<SlackApiResponse<T>> {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
	});
	const data = (await response.json()) as SlackApiResponse<T>;
	if (!response.ok || !data.ok) throw new Error(data.error || `Slack API ${method} failed`);
	return data;
}

async function listAllSlack<T extends { response_metadata?: { next_cursor?: string } }>(
	token: string,
	method: string,
	body: Record<string, unknown>,
	pick: (page: SlackApiResponse<T>) => unknown[] | undefined,
): Promise<unknown[]> {
	const items: unknown[] = [];
	let cursor: string | undefined;
	do {
		const page = await callSlack<T>(token, method, { ...body, cursor, limit: 200 });
		items.push(...(pick(page) ?? []));
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return items;
}

export const slackDiscoveryProvider: DiscoveryProvider = {
	service: "slack",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		const auth = await callSlack(draft.botToken, "auth.test");
		return {
			identity: {
				id: auth.user_id || auth.bot_id || "slack-bot",
				name: draft.name || auth.user || "Slack bot",
				userName: auth.user,
				workspaceId: auth.team_id,
				workspaceName: auth.team || auth.team_name,
			},
		};
	},
	async fetchSnapshot(accountId: string, account): Promise<DiscoverySnapshot> {
		const slackAccount = account as SlackAccountConfig;
		const validation = await this.validate({ service: "slack", botToken: slackAccount.botToken, name: account.name });
		const channels = (await listAllSlack(
			slackAccount.botToken,
			"conversations.list",
			{ types: "public_channel,private_channel,im,mpim", exclude_archived: true },
			(page) => page.channels,
		)) as SlackConversation[];
		let users: SlackUser[] = [];
		try {
			users = (await listAllSlack(slackAccount.botToken, "users.list", {}, (page) => page.members)) as SlackUser[];
		} catch {
			users = [];
		}
		return {
			accountId,
			service: "slack",
			fetchedAt: new Date().toISOString(),
			identity: validation.identity,
			channels: channels.map((channel) => ({
				id: channel.id,
				name: channel.name || channel.id,
				dm: channel.is_im,
			})),
			users: users.map((user) => ({
				id: user.id,
				name: user.name || user.real_name || user.id,
				displayName: user.profile?.display_name || user.profile?.real_name || user.real_name,
				isBot: user.is_bot,
			})),
			roles: [],
			capabilities: { canListChannels: true, canListUsers: users.length > 0, canListRoles: false },
		};
	},
};
