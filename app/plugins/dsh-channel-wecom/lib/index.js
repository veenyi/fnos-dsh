/**
 * @deepseek-ai/dsh-channel-wecom
 * fnos-dsh 定制：企业微信（WeCom）IM 渠道插件。
 *
 * 本机桌面场景：出站完整（群机器人 webhook 推送），入站尽力实现（本地 HTTP
 * 回调接收器，监听 127.0.0.1:<callbackPort>，需 ngrok/内网穿透映射公网后
 * 在企业微信回调配置中填写才能实际生效）。无回调凭据时降级为仅出站。
 * 零新增 npm 依赖：仅使用 Node 内置 http / crypto / fetch。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { createServer } from "node:http";

const name = "channel-wecom";
const inject = ["agents", "sessions", "agentDefaultModel"];

const WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
const GET_TOKEN_URL = "https://qyapi.weixin.qq.com/cgi-bin/gettoken";
const SEND_MSG_URL = "https://qyapi.weixin.qq.com/cgi-bin/message/send";

/** 配置 schema（通过 profile 的 cordis.patch.yml 或 --patch 注入）。 */
const Config = z.object({
	enabled: z.boolean().default(false),
	webhookKey: z.string().default(""),
	corpId: z.string().default(""),
	agentId: z.string().default(""),
	secret: z.string().default(""),
	callbackToken: z.string().default(""),
	encodingAESKey: z.string().default(""),
	callbackPort: z.string().default("9001")
});

/* ------------------------------------------------------------------ */
/*  出站：群机器人 webhook 推送                                        */
/* ------------------------------------------------------------------ */

/** 将 webhookKey 解析为可直接 POST 的完整 URL。 */
function webhookUrl(key) {
	if (key.startsWith("http://") || key.startsWith("https://")) return key;
	return `${WEBHOOK_URL}?key=${key}`;
}

/**
 * 推送纯文本到群机器人 webhook。
 * 内部绑定当前 config.webhookKey；外部也可显式传 key 覆盖。
 */
export async function pushText(text, key) {
	const u = webhookUrl(key);
	if (!u) return false;
	try {
		const res = await fetch(u, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msgtype: "text", text: { content: String(text) } })
		});
		const data = await res.json();
		return Number(data.errcode) === 0;
	} catch (e) {
		return false;
	}
}

/* ------------------------------------------------------------------ */
/*  入站：签名 / AES 加解密                                            */
/* ------------------------------------------------------------------ */

/** 计算 msg_signature = sha1(sorted([token,timestamp,nonce[,echostr]]))。 */
function signMsg(token, timestamp, nonce, echostr) {
	const parts = [token, timestamp, nonce, echostr].filter(Boolean).sort();
	return createHash("sha1").update(parts.join("")).digest("hex");
}

/** AES 密钥/IV：EncodingAESKey Base64 解码后前 32 字节=key，前 16 字节=iv（官方加解密方案）。 */
function makeKeyAndIv(encodingAESKey) {
	const decoded = Buffer.from(encodingAESKey, "base64");
	const key = decoded.slice(0, 32);
	const iv = decoded.slice(0, 16);
	return { key, iv };
}

/** AES-256-CBC 解密（PKCS7 填充），返回明文 Buffer。 */
function aesDecrypt(encrypted, encodingAESKey) {
	const { key, iv } = makeKeyAndIv(encodingAESKey);
	const cipher = createDecipheriv("aes-256-cbc", key, iv);
	cipher.setAutoPadding(true);
	let out = cipher.update(encrypted, undefined, "binary");
	out = Buffer.concat([out, cipher.final("binary")]);
	// out = 16字节随机前缀 + 4字节msg_body长度(网络字节序) + msg_body + corpId
	return out.slice(16);
}

/** 从解密后 Buffer 提取 msg_body 文本（校验 corpId 后缀）。 */
function extractBody(buffer, corpId) {
	if (buffer.length < 4) return null;
	const bodyLen = buffer.readUInt32BE(0);
	if (buffer.length < 4 + bodyLen) return null;
	const body = buffer.slice(4, 4 + bodyLen).toString("utf8");
	const suffix = buffer.slice(4 + bodyLen).toString("utf8");
	if (corpId && suffix !== corpId) return null;
	return body;
}

/** AES-256-CBC 加密，返回 Base64 密文。 */
function aesEncrypt(body, corpId, encodingAESKey) {
	const { key, iv } = makeKeyAndIv(encodingAESKey);
	const rand = randomBytes(16).toString("binary");
	const bodyBuf = Buffer.from(body, "utf8");
	const suffixBuf = Buffer.from(corpId || "", "utf8");
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(bodyBuf.length, 0);
	const plain = Buffer.concat([Buffer.from(rand, "binary"), lenBuf, bodyBuf, suffixBuf]);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	cipher.setAutoPadding(true);
	let out = cipher.update(plain, undefined, "binary");
	out = Buffer.concat([out, cipher.final("binary")]);
	return Buffer.from(out, "binary").toString("base64");
}

/** 极简 XML 标签取值（仅处理 WeCom 回调中的简单结构）。 */
function xmlValue(xml, tag) {
	const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
	if (!m) return "";
	return decodeXML(m[1]);
}
function decodeXML(s) {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/* ------------------------------------------------------------------ */
/*  核心：session / agent / 回复                                       */
/* ------------------------------------------------------------------ */

/** 从 session 事件流提取最终 assistant 文本（复用钉钉模板）。 */
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

/* ------------------------------------------------------------------ */
/*  入站：本地 HTTP 回调服务器                                          */
/* ------------------------------------------------------------------ */

function startCallbackReceiver(config, handleMessage, tokenStore, log) {
	const port = parseInt(config.callbackPort, 10) || 9001;
	if (!config.callbackToken || !config.encodingAESKey) return;

	const server = createServer(async (req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk.toString("utf8"); });
		req.on("end", async () => {
			try {
				const url = new URL(req.url, `http://127.0.0.1:${port}`);
				const ts = url.searchParams.get("timestamp") || "";
				const nonce = url.searchParams.get("nonce") || "";
				const sig = url.searchParams.get("msg_signature") || "";
				const echostr = url.searchParams.get("echostr") || "";

				if (req.method === "GET") {
					// 验证 URL
					const expected = signMsg(config.callbackToken, ts, nonce, echostr);
					if (expected !== sig) { res.writeHead(403).end(); return; }
					const plain = aesDecrypt(Buffer.from(echostr, "base64"), config.encodingAESKey);
					const body = extractBody(plain, config.corpId);
					res.writeHead(200, { "Content-Type": "text/plain" }).end(body || "");
					return;
				}
				if (req.method === "POST" && raw) {
					const xmlSig = xmlValue(raw, "MsgSignature") || sig;
					const xmlTs = xmlValue(raw, "TimeStamp") || ts;
					const xmlNonce = xmlValue(raw, "Nonce") || nonce;
					const encrypt = xmlValue(raw, "Encrypt");
					if (!encrypt) { res.writeHead(400).end(); return; }
					const expected = signMsg(config.callbackToken, xmlTs, xmlNonce);
					if (expected !== xmlSig) { res.writeHead(403).end(); return; }
					const plain = aesDecrypt(Buffer.from(encrypt, "base64"), config.encodingAESKey);
					const body = extractBody(plain, config.corpId);
					if (!body) { res.writeHead(400).end(); return; }
					const msgType = xmlValue(body, "MsgType");
					if (msgType !== "text") { res.writeHead(200).end(""); return; }
					const senderId = xmlValue(body, "FromUserName");
					const text = xmlValue(body, "Content");
					if (!senderId || !text) { res.writeHead(200).end(""); return; }

					const resolvedToken = await tokenStore.get(config);
					const replyFn = async (reply) => {
						if (!resolvedToken) return;
						try {
							let content = String(reply ?? "");
							if (content.length > 2048) content = content.slice(0, 2048) + "\n…(已截断)";
							await fetch(`${SEND_MSG_URL}?access_token=${resolvedToken}`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									touser: senderId,
									msgtype: "text",
									agentid: Number(config.agentId) || config.agentId,
									text: { content }
								})
							});
						} catch { /* 回复失败只记日志 */ }
					};
					// 立即回 200（企业微信要求 5 秒内响应，AI 回合异步处理，避免平台重推）
					const replyXml = aesEncrypt("", config.corpId, config.encodingAESKey);
					res.writeHead(200, { "Content-Type": "application/xml" }).end(
						`<xml><Encrypt><![CDATA[${replyXml}]]></Encrypt></xml>`
					);
					handleMessage(senderId, text, replyFn).catch((e) =>
						log.error(`wecom async turn failed: ${e?.message ?? String(e)}`)
					);
				} else {
					res.writeHead(200).end("");
				}
			} catch (e) {
				log.error(`wecom callback error: ${e?.message ?? String(e)}`);
				res.writeHead(500).end();
			}
		});
	});

	let listening = false;
	server.on("error", (e) => {
		if (!listening) {
			log.error(`wecom callback listen failed (port ${port}): ${e?.message ?? String(e)}`);
		}
	});
	try {
		server.listen(port, "127.0.0.1");
		listening = true;
		server.on("listening", () => {
			log.info(`wecom inbound receiver listening on 127.0.0.1:${port} (needs public tunnel)`);
		});
	} catch (e) {
		log.error(`wecom callback listen failed (port ${port}): ${e?.message ?? String(e)}`);
	}

	return {
		stop() {
			if (listening) server.close();
		}
	};
}

/* ------------------------------------------------------------------ */
/*  access_token 缓存（7200s）                                         */
/* ------------------------------------------------------------------ */

const tokenStore = {
	cache: { token: null, expiresAt: 0 },
	async get(config) {
		if (!config.corpId || !config.secret) return null;
		if (Date.now() < this.cache.expiresAt && this.cache.token) return this.cache.token;
		try {
			const res = await fetch(`${GET_TOKEN_URL}?corpid=${config.corpId}&corpsecret=${config.secret}`);
			const data = await res.json();
			if (Number(data.errcode) === 0) {
				this.cache.token = data.access_token;
				this.cache.expiresAt = Date.now() + 7200 * 1000;
				return data.access_token;
			}
		} catch { /* 获取失败只记日志 */ }
		return null;
	},
	reset() {
		this.cache = { token: null, expiresAt: 0 };
	}
};

/* ------------------------------------------------------------------ */
/*  apply                                                             */
/* ------------------------------------------------------------------ */

function apply(ctx, config) {
	const log = ctx.logger?.(name) ?? console;

	// 绑定出站 push 的默认 key

	const outboundOk = !!config.webhookKey;
	const inboundOk = config.enabled && !!config.corpId && !!config.agentId
		&& !!config.secret && !!config.callbackToken && !!config.encodingAESKey;

	if (!config.enabled) {
		log.info("wecom channel disabled");
		return;
	}
	if (!outboundOk && !inboundOk) {
		log.info("wecom channel disabled (no webhook and no callback credentials)");
		return;
	}

	const webhookConfigured = outboundOk;
	const callbackConfigured = inboundOk;
	log.info(`wecom channel enabled (outbound:${webhookConfigured ? "configured" : "unconfigured"}, inbound:${callbackConfigured ? "configured" : "unconfigured"})`);

	if (!webhookConfigured) {
		log.info("wecom outbound push disabled (webhookKey not configured)");
	}

	// 提供出站推送服务给上层
	try {
		if (ctx.provide && webhookConfigured) {
			ctx.provide("wecomPush", (text) => pushText(text, config.webhookKey));
		}
	} catch { /* provide 不可用不阻塞 */ }

	if (!inboundOk) {
		log.info("wecom inbound callback disabled (missing corpId/agentId/secret/token/aesKey)");
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
		sid = sid ?? SessionId(`wecom-${senderId}`);
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

	async function handleMessage(senderId, text, replyFn) {
		try {
			const agent = await ensureAgent(senderId);
			const sid = sessionByUser.get(senderId);
			if (busy.has(sid)) {
				await replyFn("[系统] 上一条消息还在处理中，请稍后再发。");
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
				await replyFn(reply || "[系统] 未生成回复。");
			} finally {
				busy.delete(sid);
			}
		} catch (error) {
			log.error(`wecom turn failed: ${error?.message ?? String(error)}`);
			await replyFn(`[系统] 处理失败：${error?.message ?? String(error)}`);
		}
	}

	startCallbackReceiver(config, handleMessage, tokenStore, log);
}

export { Config, apply, inject, name };
