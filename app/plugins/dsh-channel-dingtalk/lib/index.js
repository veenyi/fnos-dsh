/**
 * @deepseek-ai/dsh-channel-dingtalk
 * fnos-dsh 定制：钉钉 Stream 模式 IM 渠道插件（单聊 MVP）。
 *
 * 通过钉钉 Stream（WebSocket 长连接，NAS 局域网无需公网回调）接收机器人消息，
 * 归一化后驱动 dsh Agent 对话，再把最终 assistant 回复回传钉钉会话。
 * 每个钉钉用户（senderStaffId）对应一个持久 dsh session。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-dingtalk";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

/** 钉钉机器人消息回调 topic。 */
const BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";

/** 配置 schema（通过 profile 的 cordis.patch.yml 或 --patch 注入）。 */
const Config = z.object({
	enabled: z.boolean().default(false),
	appKey: z.string().default(""),
	appSecret: z.string().default("")
});

/** 从 session 事件流提取最终 assistant 文本。 */
function extractReply(session, firstSeq) {
	let started = false;
	let text = "";
	for (const event of session.events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") { started = true; continue; }
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}

/** 通过钉钉 sessionWebhook 回复文本。 */
async function replyDingtalk(sessionWebhook, text) {
	if (!sessionWebhook) return;
	await fetch(sessionWebhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ msgtype: "text", text: { content: text } })
	});
}

function apply(ctx, config) {
	const log = ctx.logger?.(name) ?? console;
	if (!config.enabled || !config.appKey || !config.appSecret) {
		log.info("dingtalk channel disabled (missing enabled/appKey/appSecret)");
		return;
	}

	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const defaultModel = ctx.get("agentDefaultModel");

	const sessionByUser = new Map();
	const agentBySession = new Map();
	const busy = new Set();

	async function ensureAgent(senderId) {
		let sid = sessionByUser.get(senderId);
		if (sid !== void 0) {
			const cached = agentBySession.get(sid);
			if (cached) return cached;
		}
		sid = sid ?? SessionId(`dingtalk-${senderId}`);
		sessionByUser.set(senderId, sid);
		const selection = defaultModel.currentSelection();
		const { agent } = await agents.create({
			sessionId: sid,
			meta: { cwd: process.cwd() },
			agentOptions: { provider: selection?.provider, model: selection?.model },
			setup: (agentCtx) => {
				installModelSelection(agentCtx, { current: selection, assembled: void 0 });
			}
		});
		await agent.whenIdle();
		agentBySession.set(sid, agent);
		return agent;
	}

	async function handleMessage(senderId, text, sessionWebhook) {
		try {
			const agent = await ensureAgent(senderId);
			const sid = sessionByUser.get(senderId);
			if (busy.has(sid)) {
				await replyDingtalk(sessionWebhook, "[系统] 上一条消息还在处理中，请稍后再发。");
				return;
			}
			busy.add(sid);
			try {
				await agent.whenIdle();
				const firstSeq = agent.session.seq;
				agent.followup(createUserMessage({
					content: [{ type: "text", text }],
					source: { kind: "user" }
				}));
				await agent.whenIdle();
				await sessions.flush(agent.session);
				const reply = extractReply(agent.session, firstSeq);
				await replyDingtalk(sessionWebhook, reply || "[系统] 未生成回复。");
			} finally {
				busy.delete(sid);
			}
		} catch (error) {
			log.error(`dingtalk turn failed: ${error?.message ?? String(error)}`);
			await replyDingtalk(sessionWebhook, `[系统] 处理失败：${error?.message ?? String(error)}`);
		}
	}

	import("dingtalk-stream").then(({ DWClient }) => {
		const client = new DWClient({ clientId: config.appKey, clientSecret: config.appSecret });
		client.registerCallbackListener(BOT_MESSAGE_TOPIC, (downstream) => {
			let data;
			try { data = JSON.parse(downstream.data); } catch { return; }
			const senderId = data?.senderStaffId ?? data?.senderId;
			const text = data?.text?.content ?? (typeof data?.text === "string" ? data.text : "");
			const sessionWebhook = data?.sessionWebhook ?? void 0;
			if (!senderId || !text) return;
			handleMessage(senderId, text, sessionWebhook).catch((e) =>
				log.error(`dingtalk handler error: ${e?.message ?? String(e)}`)
			);
		});
		client.connect().then(() => log.info("dingtalk stream connected")).catch((e) =>
			log.error(`dingtalk stream connect failed: ${e?.message ?? String(e)}`)
		);
	}).catch((e) => {
		log.error(`dingtalk-stream import failed: ${e?.message ?? String(e)}`);
	});
}

export { Config, apply, inject, name };
