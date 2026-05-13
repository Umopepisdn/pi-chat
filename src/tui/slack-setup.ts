import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { ChatConfig, SlackAccountConfig } from "../core/config-types.js";
import { makeAccountKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, showNotice } from "./dialogs.js";

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let i = 2;
	while (existing[`${base}-${i}`]) i++;
	return `${base}-${i}`;
}

export async function createSlackAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const botToken = await ctx.ui.input("Slack bot token (xoxb-...)", "xoxb-...");
	if (!botToken?.trim()) return undefined;
	const appToken = await ctx.ui.input("Slack app-level token for Socket Mode (xapp-...)", "xapp-...");
	if (!appToken?.trim()) return undefined;
	const validation = await runWithLoader(ctx, "Validating Slack bot token...", () =>
		validateAccountDraft({ service: "slack", botToken: botToken.trim() }),
	);
	if (validation.error) {
		await showNotice(ctx, "Slack setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;
	const accountLabel = await ctx.ui.input(
		"Account label",
		validation.value.identity.workspaceName ||
			validation.value.identity.userName ||
			validation.value.identity.name ||
			"slack",
	);
	if (accountLabel === undefined) return undefined;
	const accountKey = ensureUniqueKey(
		config.accounts,
		makeAccountKey("slack", accountLabel.trim() || validation.value.identity.workspaceName || "slack"),
	);
	let account: SlackAccountConfig = {
		service: "slack",
		name: accountLabel.trim() || undefined,
		botToken: botToken.trim(),
		appToken: appToken.trim(),
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, "Fetching Slack channels...", () =>
		refreshAccountSnapshot(accountKey, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Slack setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as SlackAccountConfig;
	config.accounts[accountKey] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Slack account created", `Created ${accountKey}`, "info");
	return accountKey;
}
