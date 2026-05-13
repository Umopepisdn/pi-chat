import WebSocket from "ws";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { fetchBinary, readLocalAttachment, storeDownloadedAttachment, textMentionsBot } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

interface SlackApiResponse<T> {
	ok: boolean;
	error?: string;
	warning?: string;
	response_metadata?: { warnings?: string[] };
	url?: string;
	channel?: string;
	ts?: string;
	message?: unknown;
	team?: { id?: string; name?: string };
	user?: { id?: string; name?: string; real_name?: string; is_bot?: boolean };
	channels?: SlackConversation[];
	members?: SlackUser[];
	response?: T;
}

interface SlackConnectionOpenResponse {
	url: string;
}

interface SlackPostMessageResponse {
	channel: string;
	ts: string;
}

interface SlackHistoryResponse {
	messages?: SlackMessageEvent[];
	has_more?: boolean;
}

interface SlackUploadUrlResponse {
	file_id: string;
	upload_url: string;
}

interface SlackConversation {
	id: string;
	name?: string;
	is_im?: boolean;
	is_channel?: boolean;
	is_group?: boolean;
	is_mpim?: boolean;
}

interface SlackUser {
	id: string;
	name?: string;
	real_name?: string;
	is_bot?: boolean;
	profile?: { display_name?: string; real_name?: string };
}

interface SlackFile {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	url_private_download?: string;
	url_private?: string;
}

export interface SlackMessageEvent {
	type: "message" | "app_mention";
	channel?: string;
	user?: string;
	bot_id?: string;
	subtype?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
	files?: SlackFile[];
	user_profile?: { display_name?: string; real_name?: string; name?: string };
}

export interface SlackSocketEnvelope {
	envelope_id?: string;
	type?: string;
	payload?: {
		type?: string;
		event?: SlackMessageEvent;
	};
}

export function isSupportedSlackSocketEvent(envelope: SlackSocketEnvelope): boolean {
	const type = envelope.payload?.event?.type;
	return (
		envelope.type === "events_api" &&
		envelope.payload?.type === "event_callback" &&
		(type === "message" || type === "app_mention")
	);
}

export function normalizeSlackText(text: string): string {
	return text
		.replace(/<@([A-Z0-9]+)>/g, "@$1")
		.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2")
		.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")
		.replace(/<([^>]+)>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

function slackEventIsFromBot(event: SlackMessageEvent, account: SlackAccountConfig): boolean {
	return Boolean(
		event.bot_id ||
			event.subtype === "bot_message" ||
			(event.user && account.botUserId && event.user === account.botUserId),
	);
}

async function downloadSlackFiles(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	messageId: string,
	files: SlackFile[] | undefined,
): Promise<NonNullable<InboundMessageInput["attachments"]>> {
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	let index = 0;
	for (const file of files ?? []) {
		const url = file.url_private_download || file.url_private;
		if (!url) continue;
		const data = await fetchBinary(url, { Authorization: `Bearer ${account.botToken}` });
		attachments.push(
			await storeDownloadedAttachment(
				conversation,
				messageId,
				++index,
				file.name || file.title || file.id || `slack-file-${index}`,
				data,
				file.mimetype,
				url,
			),
		);
	}
	return attachments;
}

export async function slackMessageEventToInput(
	conversation: ResolvedConversation,
	event: SlackMessageEvent,
): Promise<InboundMessageInput | undefined> {
	const account = conversation.account as SlackAccountConfig;
	if (event.channel !== conversation.channel.id) return undefined;
	if (!event.ts) return undefined;
	if (!event.user) return undefined;
	if (event.subtype && event.subtype !== "file_share") return undefined;
	if (slackEventIsFromBot(event, account)) return undefined;
	const text = normalizeSlackText(event.text || "");
	return {
		messageId: event.ts,
		...(event.thread_ts ? { threadId: event.thread_ts } : {}),
		userId: event.user,
		userName: event.user_profile?.display_name || event.user_profile?.real_name || event.user_profile?.name,
		text,
		mentionedBot:
			textMentionsBot(event.text || "", account.botUsername, account.botUserId) ||
			textMentionsBot(text, account.botUsername, account.botUserId),
		isBot: false,
		attachments: await downloadSlackFiles(conversation, account, event.ts, event.files),
	};
}

async function callSlack<T>(
	token: string,
	method: string,
	body: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
		signal,
	});
	const data = (await response.json()) as SlackApiResponse<T> & T;
	if (!response.ok || !data.ok) throw new Error(data.error || `Slack API ${method} failed`);
	return data as T;
}

async function postSlackMessage(
	account: SlackAccountConfig,
	channel: string,
	text: string,
	signal?: AbortSignal,
	threadTs?: string,
): Promise<string> {
	const data = await callSlack<SlackPostMessageResponse>(
		account.botToken,
		"chat.postMessage",
		{
			channel,
			text,
			mrkdwn: true,
			thread_ts: threadTs,
		},
		signal,
	);
	return data.ts;
}

async function uploadSlackFile(
	account: SlackAccountConfig,
	channel: string,
	path: string,
	signal?: AbortSignal,
	threadTs?: string,
	initialComment?: string,
): Promise<string> {
	const file = await readLocalAttachment(path);
	const upload = await callSlack<SlackUploadUrlResponse>(
		account.botToken,
		"files.getUploadURLExternal",
		{ filename: file.name, length: file.data.byteLength },
		signal,
	);
	const uploadResponse = await fetch(upload.upload_url, {
		method: "POST",
		headers: { "content-type": file.mimeType || "application/octet-stream" },
		body: Buffer.from(file.data),
		signal,
	});
	if (!uploadResponse.ok) throw new Error(`Slack file upload failed: ${uploadResponse.status}`);
	await callSlack(
		account.botToken,
		"files.completeUploadExternal",
		{
			files: [{ id: upload.file_id, title: file.name }],
			channel_id: channel,
			initial_comment: initialComment,
			thread_ts: threadTs,
		},
		signal,
	);
	return upload.file_id;
}

async function sendSlackMessage(
	account: SlackAccountConfig,
	channel: string,
	content: string,
	attachmentPaths: string[] = [],
	signal?: AbortSignal,
	replyToMessageId?: string,
): Promise<string> {
	const rendered = formatMarkdownForService("slack", content);
	const chunks = chunkText(rendered.text, maxMessageLength("slack"));
	let firstMessageId: string | undefined;
	if (attachmentPaths.length === 0 || rendered.text) {
		for (let i = 0; i < chunks.length; i++) {
			const id = await postSlackMessage(account, channel, chunks[i], signal, i === 0 ? replyToMessageId : undefined);
			firstMessageId ??= id;
		}
	}
	for (const path of attachmentPaths) {
		const id = await uploadSlackFile(account, channel, path, signal, replyToMessageId || firstMessageId);
		firstMessageId ??= id;
	}
	return firstMessageId || "";
}

function openWebSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

async function catchUpSlack(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	handlers: LiveConnectionHandlers,
	afterTs?: string,
): Promise<void> {
	const allMessages: SlackMessageEvent[] = [];
	let cursor: string | undefined;
	do {
		const page = await callSlack<SlackHistoryResponse>(account.botToken, "conversations.history", {
			channel: conversation.channel.id,
			oldest: afterTs,
			inclusive: false,
			limit: 100,
			cursor,
		});
		allMessages.push(...(page.messages ?? []));
		cursor = page.has_more
			? (page as unknown as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor
			: undefined;
	} while (cursor);
	for (const message of allMessages.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))) {
		const input = await slackMessageEventToInput(conversation, message);
		if (!input) continue;
		await handlers.onMessage(input, { messageId: input.messageId, cursor: input.messageId });
	}
}

export async function connectSlackLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as SlackAccountConfig;
	const connection = await callSlack<SlackConnectionOpenResponse>(account.appToken, "apps.connections.open");
	const ws = await openWebSocket(connection.url);
	await catchUpSlack(conversation, account, handlers, resumeState?.cursor || resumeState?.messageId);
	await handlers.onCaughtUp();
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) =>
			sendSlackMessage(account, conversation.channel.id, text, [], undefined, replyToMessageId),
		edit: async (_id, _text) => {},
		delete: async (_id) => {},
	});

	let disconnected = false;
	ws.on("message", (raw) => {
		void (async () => {
			try {
				const envelope = JSON.parse(raw.toString()) as SlackSocketEnvelope;
				if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
				const event = envelope.payload?.event;
				if (!isSupportedSlackSocketEvent(envelope) || !event) return;
				const input = await slackMessageEventToInput(conversation, event);
				if (!input) return;
				await handlers.onMessage(input, { messageId: input.messageId, cursor: input.messageId });
			} catch (error) {
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			}
		})();
	});
	ws.on("error", (error) => void handlers.onError(error instanceof Error ? error : new Error(String(error))));
	ws.on("close", () => {
		if (disconnected) return;
		disconnected = true;
		void handlers.onDisconnect?.();
	});

	return {
		conversation,
		disconnect: async () => {
			disconnected = true;
			ws.close();
		},
		sendImmediate: async (text, replyToMessageId) =>
			postSlackMessage(account, conversation.channel.id, text, undefined, replyToMessageId),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) =>
			sendSlackMessage(account, conversation.channel.id, text, attachmentPaths, signal, replyToMessageId),
		startTyping: async () => {},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
