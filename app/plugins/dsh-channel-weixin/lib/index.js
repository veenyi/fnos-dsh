/**
 * @deepseek-ai/dsh-channel-weixin
 * dsh-desktop 定制：微信个人号机器人渠道插件（腾讯 iLink bot API，长轮询）。
 *
 * 收发协议（对齐 hermes-src/gateway/platforms/weixin.py）：
 * - 收：POST {base}/ilink/bot/getupdates  {"get_updates_buf":"<游标>","base_info":{"channel_version":"2.2.0"}}
 *   → { ret, errcode, msgs[], get_updates_buf }，msgs[].item_list[].type==1 为文本。
 * - 发：POST {base}/ilink/bot/sendmessage {"msg":{from_user_id:"",to_user_id,client_id,message_type:2,
 *   message_state:2,context_token?,item_list:[{type:1,text_item:{text}}]},"base_info":{...}}
 * - 鉴权头：Authorization: Bearer {token} + AuthorizationType: ilink_bot_token +
 *   X-WECHAT-UIN(随机base64) + iLink-App-Id: bot + iLink-App-ClientVersion。
 * - errcode -14（或 ret/errcode -2 + errmsg=unknown error）＝会话过期：暂停 600s；-2 限频退避。
 * - 每个微信用户（from_user_id）对应一个持久 dsh session；回复必须回显最新 context_token。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import crypto from "node:crypto";

/** Stable Cordis plugin name. */
const name = "channel-weixin";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const CHANNEL_VERSION = "2.2.0";
const APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const LONG_POLL_TIMEOUT = 40000;
const API_TIMEOUT = 15000;
const SESSION_EXPIRED = -14;
const RATE_LIMIT = -2;
const WX_MSG_MAX = 2000;

/** 配置 schema（通过 patch / profile 注入；扫码后自动填入）。 */
const Config = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(""),
  accountId: z.string().default(""),
  baseUrl: z.string().default("")
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

/** 随机 X-WECHAT-UIN（对齐 hermes：4 字节大端整数 base64）。 */
function randomUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

/** iLink 请求头。 */
function wxHeaders(token, body) {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": APP_CLIENT_VERSION,
    Authorization: `Bearer ${token}`
  };
}

/** iLink POST 封装。 */
async function wxPost(baseUrl, token, endpoint, payload, timeoutMs) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/${endpoint}`, {
    method: "POST",
    headers: wxHeaders(token, body),
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`iLink POST ${endpoint} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json().catch(() => ({}));
}

/** 从 item_list 提取文本（type 1）。 */
function extractText(itemList) {
  for (const item of (itemList || [])) {
    if (item && item.type === 1 && item.text_item && typeof item.text_item.text === "string") {
      return item.text_item.text;
    }
  }
  return "";
}

function backoffMs(attempt) {
  const base = 1000 * Math.min(2 ** attempt, 32);
  return base + Math.floor(Math.random() * base);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apply(ctx, config) {
  const log = ctx.logger?.(name) ?? console;

  if (!config.enabled || !config.token || !config.accountId) {
    log.info("weixin channel disabled (missing enabled/token/accountId)");
    return;
  }

  log.info("weixin channel enabled (token configured, account=" + config.accountId + ")");

  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  const baseUrl = config.baseUrl || "https://ilinkai.weixin.qq.com";

  const sessionByUser = new Map();
  const agentBySession = new Map();
  const busy = new Set();
  const ctxTokenByUser = new Map(); // peer -> context_token

  async function ensureAgent(senderId) {
    let sid = sessionByUser.get(senderId);
    if (sid !== void 0) {
      const cached = agentBySession.get(sid);
      if (cached) return cached;
    }
    sid = sid ?? SessionId(`weixin-${senderId}`);
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

  /** 发送文本回复（errcode -14 时去掉 context_token 重试一次）。 */
  async function replyWeixin(toUserId, text, contextToken) {
    let content = String(text ?? "");
    if (content.length > WX_MSG_MAX) content = content.slice(0, WX_MSG_MAX) + "\n…(已截断)";
    const message = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: content } }]
    };
    if (contextToken) message.context_token = contextToken;
    const resp = await wxPost(baseUrl, config.token, EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT);
    const errcode = Number(resp.errcode || resp.ret || 0);
    if (errcode === SESSION_EXPIRED && contextToken) {
      delete message.context_token;
      await wxPost(baseUrl, config.token, EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT);
    } else if (errcode === RATE_LIMIT) {
      log.warn("weixin rate limited, waiting 30s before next send");
      await wait(30000);
    }
  }

  async function handleMessage(msg) {
    try {
      const senderId = String(msg.from_user_id || "").trim();
      const text = extractText(msg.item_list).trim();
      if (!senderId || !text) return;
      // 缓存回显用的 context_token
      const inboundCtx = String(msg.context_token || "").trim();
      if (inboundCtx) ctxTokenByUser.set(senderId, inboundCtx);

      const agent = await ensureAgent(senderId);
      const sid = sessionByUser.get(senderId);
      if (busy.has(sid)) {
        await replyWeixin(senderId, "[系统] 上一条消息还在处理中，请稍后再发。", ctxTokenByUser.get(senderId));
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
        await replyWeixin(senderId, reply || "[系统] 未生成回复。", ctxTokenByUser.get(senderId));
      } finally {
        busy.delete(sid);
      }
    } catch (error) {
      log.error(`weixin turn failed: ${error?.message ?? String(error)}`);
      try {
        await replyWeixin(String(msg.from_user_id || "").trim(), `[系统] 处理失败：${error?.message ?? String(error)}`, ctxTokenByUser.get(String(msg.from_user_id || "").trim()));
      } catch { /* ignore */ }
    }
  }

  /** 长轮询接收循环（游标 + 会话过期暂停 + 退避重连）。 */
  async function startPolling() {
    let syncBuf = "";
    let attempt = 0;
    let stopped = false;
    while (!stopped) {
      try {
        const resp = await wxPost(baseUrl, config.token, EP_GET_UPDATES, { get_updates_buf: syncBuf }, LONG_POLL_TIMEOUT);
        const ret = Number(resp.ret || 0);
        const errcode = Number(resp.errcode || 0);
        const errmsg = String(resp.errmsg || "");
        if (ret !== 0 || errcode !== 0) {
          if (errcode === SESSION_EXPIRED || (ret === RATE_LIMIT && errmsg.toLowerCase() === "unknown error")) {
            log.error("weixin session expired, pausing 10 min");
            await wait(600000);
            attempt = 0;
            continue;
          }
          attempt += 1;
          log.warning(`weixin getUpdates ret=${ret} errcode=${errcode} errmsg=${errmsg} (${attempt}/3)`);
          await wait(attempt >= 3 ? 30000 : 2000);
          if (attempt >= 3) attempt = 0;
          continue;
        }
        attempt = 0;
        const newBuf = String(resp.get_updates_buf || "");
        if (newBuf) syncBuf = newBuf;
        for (const m of (resp.msgs || [])) handleMessage(m);
      } catch (e) {
        const m = String(e?.message || e);
        if (m.includes("aborted") || m.includes("timeout")) continue; // 长轮询超时正常续轮
        attempt += 1;
        log.error(`weixin poll error: ${m}`);
        await wait(backoffMs(attempt));
        if (attempt >= 6) attempt = 0;
      }
    }
  }

  startPolling().catch((e) => log.error(`weixin polling exited: ${String(e?.message || e)}`));
  log.info("weixin polling started");
}

export { Config, apply, inject, name };
