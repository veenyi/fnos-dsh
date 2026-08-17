/**
 * @deepseek-ai/dsh-channel-discord
 * dsh-desktop 定制：Discord IM 渠道插件（Gateway v10，WebSocket 出站）。
 *
 * 通过 Discord Gateway WebSocket 接收机器人消息，归一化后驱动 dsh Agent 对话，
 * 再经 REST API 把最终 assistant 回复发回原 Discord 频道/会话。
 * 每个 Discord 用户（author.id）对应一个持久 dsh session。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-discord";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

/** Discord 单条消息正文上限（字符）。 */
const DISCORD_MSG_MAX = 2000;

/** Gateway v10 WebSocket 端点（json 编码）。 */
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** 出站回复 REST 端点模板。 */
const MSG_ENDPOINT = "https://discord.com/api/v10/channels";

/** 所需 intents：GUILD_MESSAGES(9) | DIRECT_MESSAGES(12) | MESSAGE_CONTENT(15)。 */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

/** 配置 schema（通过 patch / profile 注入；token 来自 DISCORD_TOKEN 环境变量映射）。 */
const Config = z.object({
	enabled: z.boolean().default(false),
	token: z.string().default("")
});

/** 从 session 事件流提取最终 assistant 文本（复用钉钉模板逻辑）。 */
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

/** 经 REST API 向指定 channel_id 发送纯文本回复。 */
async function replyDiscord(token, channelId, text) {
	if (!token || !channelId) return;
	let content = String(text ?? "");
	if (content.length > DISCORD_MSG_MAX) content = content.slice(0, DISCORD_MSG_MAX);
	await fetch(`${MSG_ENDPOINT}/${channelId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${token}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ content })
	});
}

/** 指数退避等待时间（ms）：初始 1s，上界 30s，含随机抖动。 */
function backoffMs(attempt) {
	const base = 1000 * Math.min(2 ** attempt, 32);
	return base + Math.floor(Math.random() * base);
}

/** 等待 ms 毫秒。 */
function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function apply(ctx, config) {
	const log = ctx.logger?.(name) ?? console;

	if (!config.enabled || !config.token) {
		log.info("discord channel disabled (missing enabled/token)");
		return;
	}

	log.info("discord channel enabled (token configured)");

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
		sid = sid ?? SessionId(`discord-${senderId}`);
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

	async function handleMessage(senderId, text, channelId) {
		try {
			const agent = await ensureAgent(senderId);
			const sid = sessionByUser.get(senderId);
			if (busy.has(sid)) {
				await replyDiscord(config.token, channelId, "[系统] 上一条消息还在处理中，请稍后再发。");
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
				await replyDiscord(config.token, channelId, reply || "[系统] 未生成回复。");
			} finally {
				busy.delete(sid);
			}
		} catch (error) {
			log.error(`discord turn failed: ${error?.message ?? String(error)}`);
			await replyDiscord(config.token, channelId, `[系统] 处理失败：${error?.message ?? String(error)}`);
		}
	}

	/** 启动 Gateway 接收循环（含鉴权、心跳、重连）。 */
	async function startReceiveLoop() {
		let ws = null;
		let heartbeatInterval = 0;
		let heartbeatTimer = null;
		let reconnectTimer = null;
		let lastSeq = null;
		let heartbeatTimeout = null;
		let heartbeatAcked = true;
		let running = true;
		let attempt = 0;

		function cleanup() {
			if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
			if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			if (ws) {
				try { ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null; } catch { /* ignore */ }
				try { ws.close(4940, "reconnect"); } catch { /* ignore */ }
				ws = null;
			}
		}

		function sendRaw(obj) {
			if (ws && ws.readyState === 1) {
				try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
			}
		}

		function scheduleHeartbeat() {
			if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
			if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
			heartbeatAcked = true;
			heartbeatTimer = setInterval(() => {
				if (ws && ws.readyState === 1) {
					sendRaw({ op: 1, d: lastSeq });
					heartbeatAcked = false;
					heartbeatTimeout = setTimeout(() => {
						if (!heartbeatAcked) {
							log.info("discord heartbeat timeout, reconnecting");
							cleanup();
							scheduleReconnect();
						}
					}, heartbeatInterval);
				}
			}, heartbeatInterval);
		}

		function identify() {
			sendRaw({
				op: 2,
				d: {
					token: config.token,
					intents: INTENTS,
					properties: { os: "windows", browser: "dsh-desktop", device: "dsh-desktop" }
				}
			});
		}

		function connect() {
			if (!running) return;
			try {
				ws = new globalThis.WebSocket(GATEWAY_URL);
			} catch (e) {
				log.error(`discord gateway connect error: ${e?.message ?? String(e)}`);
				scheduleReconnect();
				return;
			}

			ws.onopen = () => {
				log.info("discord gateway socket opened");
				attempt = 0;
			};

			ws.onmessage = (event) => {
				let data;
				try {
					data = JSON.parse(typeof event.data === "string" ? event.data : event.data);
				} catch {
					return;
				}
				const op = data.op;
				if (op === 10) {
					// HELLO：取心跳间隔并开始鉴权 + 心跳。
					heartbeatInterval = Number(data.d?.heartbeat_interval);
					if (heartbeatInterval <= 0) heartbeatInterval = 41250;
					log.info(`discord gateway hello, heartbeat ${heartbeatInterval}ms`);
					identify();
					scheduleHeartbeat();
				} else if (op === 0) {
					// DISPATCH：记录 seq，处理 MESSAGE_CREATE。
					if (data.s !== void 0) lastSeq = data.s;
					handleDispatch(data);
				} else if (op === 11) {
					// HEARTBEAT_ACK：忽略，仅复位超时状态。
					heartbeatAcked = true;
					return;
				} else if (op === 7) {
					// RECONNECT：服务端要求重连。
					log.info("discord gateway reconnect requested");
					cleanup();
					scheduleReconnect();
				}
			};

			ws.onclose = (event) => {
				log.info(`discord gateway closed code=${event?.code} reason=${event?.reason ?? ""}`);
				cleanup();
				if (event?.code !== 4940) scheduleReconnect();
			};

			ws.onerror = (err) => {
				log.error(`discord gateway error: ${err?.message ?? err?.error ?? String(err)}`);
			};
		}

		function handleDispatch(data) {
			if (data.t !== "MESSAGE_CREATE") return;
			const d = data.d;
			if (!d || !d.channel_id) return;
			const author = d.author;
			if (!author || !author.id || author.bot === true) return;
			const content = d.content;
			if (typeof content !== "string" || content.length === 0) return;
			handleMessage(author.id, content, d.channel_id).catch((e) =>
				log.error(`discord handler error: ${e?.message ?? String(e)}`)
			);
		}

		function scheduleReconnect() {
			const delay = backoffMs(attempt++);
			log.info(`discord gateway reconnect in ${delay}ms`);
			running = true;
			reconnectTimer = setTimeout(() => {
				heartbeatInterval = 0;
				lastSeq = null;
				running = true;
				connect();
			}, delay);
		}

		connect();
	}

	startReceiveLoop().catch((e) =>
		log.error(`discord receive loop failed: ${e?.message ?? String(e)}`)
	);
}

export { Config, apply, inject, name };
