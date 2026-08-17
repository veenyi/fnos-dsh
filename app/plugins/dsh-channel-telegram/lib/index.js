/**
 * @deepseek-ai/dsh-channel-telegram
 * dsh-desktop 定制：Telegram Bot 渠道插件（Bot API 长轮询）。
 *
 * 通过 Telegram Bot API getUpdates 长轮询接收消息，归一化后驱动 dsh Agent 对话，
 * 再用 sendMessage 把最终 assistant 回复发回原 chat。
 * 每个 Telegram 用户（from.id）对应一个持久 dsh session。
 * Token 由扫码创建（Nous 托管）或 BotFather 手动创建，经 TELEGRAM_BOT_TOKEN 注入。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-telegram";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

const API = "https://api.telegram.org/bot";

/** 配置 schema（通过 patch / profile 注入）。 */
const Config = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(""),
  allowedUsers: z.string().default("")
});

/** 从 session 事件流提取最终 assistant 文本（复用钉钉/企微模板逻辑）。 */
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

/** 经 Bot API 发送纯文本回复（截断到 4000 字符内）。 */
async function replyTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  let content = String(text ?? "");
  if (content.length > 4000) content = content.slice(0, 4000) + "\n…(已截断)";
  await fetch(`${API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), text: content })
  });
}

/** 等待 ms 毫秒。 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apply(ctx, config) {
  const log = ctx.logger?.(name) ?? console;

  if (!config.enabled || !config.token) {
    log.info("telegram channel disabled (missing enabled/token)");
    return;
  }

  log.info("telegram channel enabled (token configured)");

  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");

  const allowSet = new Set(
    String(config.allowedUsers || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const sessionByUser = new Map();
  const agentBySession = new Map();
  const busy = new Set();

  async function ensureAgent(senderId) {
    let sid = sessionByUser.get(senderId);
    if (sid !== void 0) {
      const cached = agentBySession.get(sid);
      if (cached) return cached;
    }
    sid = sid ?? SessionId(`telegram-${senderId}`);
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

  async function handleMessage(fromId, chatId, text) {
    try {
      const agent = await ensureAgent(fromId);
      const sid = sessionByUser.get(fromId);
      if (busy.has(sid)) {
        await replyTelegram(config.token, chatId, "[系统] 上一条消息还在处理中，请稍后再发。");
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
        await replyTelegram(config.token, chatId, reply || "[系统] 未生成回复。");
      } finally {
        busy.delete(sid);
      }
    } catch (error) {
      log.error(`telegram turn failed: ${error?.message ?? String(error)}`);
      await replyTelegram(config.token, chatId, `[系统] 处理失败：${error?.message ?? String(error)}`);
    }
  }

  /** 长轮询接收循环（offset 机制 + 指数退避重连）。 */
  async function startPolling() {
    let offset = 0;
    let attempt = 0;
    let stopped = false;

    while (!stopped) {
      try {
        const res = await fetch(`${API}${config.token}/getUpdates?timeout=25&offset=${offset}`, {
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          log.error(`telegram getUpdates ${res.status}: ${t.slice(0, 120)}`);
          await wait(backoffMs(attempt));
          attempt = Math.min(attempt + 1, 6);
          continue;
        }
        attempt = 0;
        const d = await res.json().catch(() => ({}));
        if (d && d.ok === false) {
          // token 失效/被禁：Telegram 返回 HTTP 200 + {ok:false}，记录并退避，避免静默空转
          log.error(`telegram getUpdates api error: ${d.description || "unknown"} (token 可能失效，请重新扫码创建机器人)`);
          await wait(backoffMs(attempt));
          attempt = Math.min(attempt + 1, 6);
          continue;
        }
        for (const update of (d.result || [])) {
          offset = Math.max(offset, update.update_id + 1);
          const msg = update.message || update.edited_message;
          if (!msg || !msg.text) continue;
          const fromId = String(msg.from && msg.from.id != null ? msg.from.id : "");
          const chatId = String(msg.chat && msg.chat.id != null ? msg.chat.id : "");
          if (!fromId || !chatId) continue;
          // 白名单过滤（配置了才生效）
          if (allowSet.size && !allowSet.has(fromId)) continue;
          // 忽略机器人命令（/start 等），避免无谓对话
          if (/^\/(start|help)$/i.test(String(msg.text).trim())) continue;
          // 不处理自己发出去的消息（机器人自身消息不会出现在 update，防御性跳过空文本）
          handleMessage(fromId, chatId, String(msg.text).slice(0, 6000)).catch((e) =>
            log.error(`telegram handleMessage error: ${e?.message ?? String(e)}`)
          );
        }
      } catch (e) {
        const m = String(e?.message || e);
        if (m.includes("aborted") || m.includes("timeout")) {
          // 长轮询超时属正常，立即续轮
          continue;
        }
        log.error(`telegram poll error: ${m}`);
        await wait(backoffMs(attempt));
        attempt = Math.min(attempt + 1, 6);
      }
    }
  }

  // 启动长轮询（不阻塞插件加载）
  startPolling().catch((e) => log.error(`telegram polling exited: ${String(e?.message || e)}`));
  log.info("telegram polling started");
}

/** 指数退避等待时间（ms）：初始 1s，上界 30s。 */
function backoffMs(attempt) {
  const base = 1000 * Math.min(2 ** attempt, 32);
  return base + Math.floor(Math.random() * base);
}

export { Config, apply, inject, name };
