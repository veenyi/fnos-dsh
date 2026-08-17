/**
 * @deepseek-ai/dsh-channel-feishu
 * dsh-desktop 定制：飞书机器人渠道插件（官方 @larksuiteoapi/node-sdk 长连接）。
 *
 * 用官方 WSClient（长连接接收事件）+ EventDispatcher 订阅 im.message.receive_v1，
 * 消息归一化后驱动 dsh Agent 对话，再经 im.message.create 把回复发回原会话。
 * 每个飞书用户（open_id）对应一个持久 dsh session。
 *
 * 修复历史：旧版手写 JSON 长连接协议与官方 pbbp2 protobuf 帧不兼容（阻断），
 * 已整体替换为官方 SDK 实现。
 */
import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-feishu";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

const FEISHU_MSG_MAX = 3800;

/** 配置 schema（通过 patch / profile 注入；凭据来自 FEISHU_APP_ID/APP_SECRET）。 */
const Config = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
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

function apply(ctx, config) {
  const log = ctx.logger?.(name) ?? console;

  if (!config.enabled || !config.appId || !config.appSecret) {
    log.info("feishu channel disabled (missing enabled/appId/appSecret)");
    return;
  }

  log.info("feishu channel enabled (appId=" + config.appId + ")");

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
    sid = sid ?? SessionId(`feishu-${senderId}`);
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

  const client = new Client({ appId: config.appId, appSecret: config.appSecret });

  /** 发送文本回复到指定会话。 */
  async function replyFeishu(chatId, text) {
    if (!chatId) return;
    let content = String(text ?? "");
    if (content.length > FEISHU_MSG_MAX) content = content.slice(0, FEISHU_MSG_MAX) + "\n…(已截断)";
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: content }) }
      });
    } catch (e) {
      log.error(`feishu reply error: ${e?.message ?? String(e)}`);
    }
  }

  async function handleMessage(senderId, chatId, text) {
    try {
      let sid = sessionByUser.get(senderId);
      if (sid && busy.has(sid)) {
        await replyFeishu(chatId, "[系统] 上一条消息还在处理中，请稍后再发。");
        return;
      }
      const agent = await ensureAgent(senderId);
      sid = sessionByUser.get(senderId);
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
        await replyFeishu(chatId, reply || "[系统] 未生成回复。");
      } finally {
        busy.delete(sid);
      }
    } catch (error) {
      log.error(`feishu turn failed: ${error?.message ?? String(error)}`);
      await replyFeishu(chatId, `[系统] 处理失败：${error?.message ?? String(error)}`);
    }
  }

  // ── 官方长连接接收事件 ──
  const dispatcher = new EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        const event = data?.event || {};
        const message = event.message || {};
        const sender = event.sender || {};
        const chatId = String(message.chat_id || "");
        const senderId = String((sender.sender_id && (sender.sender_id.open_id || sender.sender_id.user_id)) || "");
        if (!chatId || !senderId) return;
        if (message.message_type !== "text") return;
        let text = "";
        try { text = (JSON.parse(message.content || "{}").text || "").trim(); } catch { /* ignore */ }
        if (!text) return;
        handleMessage(senderId, chatId, text.slice(0, 6000)).catch((e) =>
          log.error(`feishu handler error: ${e?.message ?? String(e)}`)
        );
      } catch (e) {
        log.error(`feishu event error: ${e?.message ?? String(e)}`);
      }
    }
  });

  const wsClient = new WSClient({ appId: config.appId, appSecret: config.appSecret });
  wsClient.start({ eventDispatcher: dispatcher }).catch((e) =>
    log.error(`feishu WSClient start failed: ${e?.message ?? String(e)}`)
  );
  log.info("feishu WSClient started");
}

export { Config, apply, inject, name };
