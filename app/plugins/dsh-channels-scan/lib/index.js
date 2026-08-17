/**
 * @deepseek-ai/dsh-channels-scan
 * 飞牛版（fnos-dsh）IM 渠道扫码配置插件。
 *
 * 提供 web 端扫码配置页（NAS 浏览器访问 http://<nas>:3080/scan）：
 * - 微信个人号：腾讯 iLink 扫码登录，confirmed 自动写 data/.env（WEIXIN_TOKEN/ACCOUNT_ID/BASE_URL）
 * - Telegram：Nous 托管扫码创建机器人，ready 自动写 data/.env（TELEGRAM_BOT_TOKEN）
 * - 手动凭据保存 / 状态查询
 *
 * 写 .env 后需重启应用（dsh 进程启动时经 cmd/main source .env 注入环境变量）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import z from "@deepseek-ai/schemastery";

const name = "channels-scan";
const inject = ["webServer"];

const Config = z.object({
  enabled: z.boolean().default(true)
});

/** .env 文件：优先 DSH_HOME（dsh 数据目录），fallback 当前目录 */
function envFilePath() {
  const home = process.env.DSH_HOME || "";
  if (home && fs.existsSync(home)) return path.join(home, ".env");
  return path.join(process.cwd(), ".env");
}

function readEnv() {
  const out = {};
  const p = envFilePath();
  try {
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return out;
}

function writeEnv(env) {
  const p = envFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`${k}=${String(v)}`);
  }
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

function randomUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function wxHeaders(token, body) {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (2 << 8) | 0),
    Authorization: `Bearer ${token}`
  };
}

async function wxPost(baseUrl, token, endpoint, payload, timeoutMs) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: "2.2.0" } });
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/${endpoint}`, {
    method: "POST",
    headers: wxHeaders(token, body),
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`iLink POST ${endpoint} HTTP ${res.status}`);
  return await res.json().catch(() => ({}));
}

const telegramPairings = new Map(); // pairing_id -> { poll_token }

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function apply(ctx, config) {
  if (!config.enabled) return;
  const log = ctx.logger?.(name) ?? console;

  // 静态配置页
  const scanHtml = fs.readFileSync(path.join(import.meta.dirname, "scan.html"), "utf8");

  ctx.webServer.register({
    kind: "exact",
    path: "/scan",
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(scanHtml) });
      res.end(scanHtml);
    }
  });

  // 渠道状态（脱敏）
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/status",
    handler: (req, res) => {
      const env = readEnv();
      const status = (keys) => keys.every((k) => !!String(env[k] || "").trim());
      json(res, 200, {
        ok: true,
        envFile: envFilePath(),
        channels: {
          weixin: { configured: status(["WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID"]), token: !!String(env.WEIXIN_TOKEN || "").trim() },
          telegram: { configured: status(["TELEGRAM_BOT_TOKEN"]), token: !!String(env.TELEGRAM_BOT_TOKEN || "").trim() },
          dingtalk: { configured: status(["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"]) },
          feishu: { configured: status(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]) },
          discord: { configured: status(["DISCORD_TOKEN"]) },
          wecom: { configured: status(["WECOM_WEBHOOK_KEY"]) },
          qq: { configured: status(["QQ_APP_ID", "QQ_BOT_TOKEN"]) }
        }
      });
    }
  });

  // 手动保存凭据（仅允许白名单 KEY）
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/env",
    handler: async (req, res) => {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");
        const entries = parsed.entries || {};
        const allow = /^(WEIXIN_|TELEGRAM_|DINGTALK_|FEISHU_|DISCORD_|WECOM_|QQ_)[A-Z0-9_]*$/;
        const env = readEnv();
        for (const [k, v] of Object.entries(entries)) {
          if (!allow.test(k)) continue;
          const val = String(v || "").trim();
          if (val) env[k] = val;
        }
        writeEnv(env);
        json(res, 200, { ok: true, message: "已保存到 " + envFilePath() + "，重启应用后生效" });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
  });

  // ── 微信 iLink 扫码 ──
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/weixin/qr",
    handler: async (req, res) => {
      try {
        const r = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error("iLink " + r.status);
        const d = await r.json().catch(() => ({}));
        const qrcode = String(d.qrcode || "").trim();
        if (!qrcode) throw new Error("未取到微信二维码，请检查网络");
        const deep = String(d.qrcode_img_content || "").trim();
        json(res, 200, { ok: true, qrcode, qr_payload: deep || ("https://ilinkai.weixin.qq.com/ilink/bot/scan?qrcode=" + encodeURIComponent(qrcode)) });
      } catch (e) {
        json(res, 502, { ok: false, error: String(e?.message || e) });
      }
    }
  });
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/weixin/status",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        const qrcode = url.searchParams.get("qrcode") || "";
        const r = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode), { signal: AbortSignal.timeout(35000) });
        if (!r.ok) throw new Error("iLink status " + r.status);
        const d = await r.json().catch(() => ({}));
        const status = String(d.status || d.result || "wait").toLowerCase();
        if (status === "confirmed") {
          const token = String(d.bot_token || "").trim();
          const accountId = String(d.ilink_bot_id || "").trim();
          const baseUrl = String(d.baseurl || "").trim();
          if (token) {
            const env = readEnv();
            if (token) env.WEIXIN_TOKEN = token;
            if (accountId) env.WEIXIN_ACCOUNT_ID = accountId;
            if (baseUrl) env.WEIXIN_BASE_URL = baseUrl;
            writeEnv(env);
          }
        }
        json(res, 200, { ok: true, status });
      } catch (e) {
        json(res, 502, { ok: false, error: String(e?.message || e) });
      }
    }
  });

  // ── Telegram Nous 扫码创建 ──
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/telegram/qr",
    handler: async (req, res) => {
      try {
        const url = process.env.TELEGRAM_ONBOARDING_URL || "https://setup.hermes-agent.nousresearch.com";
        const r = await fetch(url + "/v1/telegram/pairings", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ bot_name: "fnOS DSH Agent" }),
          signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) throw new Error("onboarding service " + r.status);
        const d = await r.json().catch(() => ({}));
        const pairingId = String(d.pairing_id || "").trim();
        const pollToken = String(d.poll_token || "").trim();
        if (!pairingId || !pollToken) throw new Error("incomplete onboarding response");
        telegramPairings.set(pairingId, { poll_token: pollToken });
        json(res, 200, { ok: true, pairing_id: pairingId, qr_payload: String(d.qr_payload || d.deep_link || "").trim() });
      } catch (e) {
        json(res, 502, { ok: false, error: String(e?.message || e) });
      }
    }
  });
  ctx.webServer.register({
    kind: "exact",
    path: "/api/channels-scan/telegram/status",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        const pairingId = url.searchParams.get("pairing_id") || "";
        const held = telegramPairings.get(pairingId);
        if (!held) return json(res, 400, { ok: false, error: "pairing 不存在或已过期，请重新生成" });
        const base = process.env.TELEGRAM_ONBOARDING_URL || "https://setup.hermes-agent.nousresearch.com";
        const r = await fetch(base + "/v1/telegram/pairings/" + encodeURIComponent(pairingId), {
          headers: { "Authorization": "Bearer " + held.poll_token, "Accept": "application/json" },
          signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) throw new Error("onboarding status " + r.status);
        const d = await r.json().catch(() => ({}));
        const status = String(d.status || "waiting").toLowerCase();
        if (status === "ready" || status === "claimed") {
          const token = String(d.token || "").trim();
          if (token) {
            telegramPairings.delete(pairingId);
            const env = readEnv();
            env.TELEGRAM_BOT_TOKEN = token;
            writeEnv(env);
          }
        }
        json(res, 200, { ok: true, status, bot_username: String(d.bot_username || ""), owner_user_id: String(d.owner_user_id || "") });
      } catch (e) {
        json(res, 502, { ok: false, error: String(e?.message || e) });
      }
    }
  });

  log.info("channels-scan mounted (/scan + /api/channels-scan/*)");
}

export { Config, apply, inject, name };
