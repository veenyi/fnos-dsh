# dsh-channel-discord 协议说明

> 基于 Discord Gateway v10（WebSocket）+ REST API v10。
> 官方文档：
> - Gateway / Events：https://discord.com/developers/docs/events/gateway
> - Message 资源：https://discord.com/developers/docs/resources/message
> - Gateway 连接与事件码：https://discord.com/developers/docs/topics/gateway

## 连接与鉴权
客户端通过 WebSocket 连接 `wss://gateway.discord.gg/?v=10&encoding=json`。连接建立后服务端立即推送 **OP 10 HELLO**，其 `d` 携带 `heartbeat_interval`（毫秒）。客户端据此启动心跳，并在收到 HELLO 后发送 **OP 2 IDENTIFY**：

```
{ op: 2, d: { token, intents, properties } }
```

`intents` 取 `(1<<9) | (1<<12) | (1<<15)`，即 `GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT`（读取消息正文必须启用 MESSAGE_CONTENT）。`properties` 固定为 `{ os: "windows", browser: "dsh-desktop", device: "dsh-desktop" }`。鉴权通过则开始收到事件流。

## 心跳与重连
客户端按 `heartbeat_interval` 周期性发送 **OP 1  HEARTBEAT**（`{ op: 1, d: lastSeq }`，`lastSeq` 为最近一次 **OP 0 DISPATCH** 帧的 `s` 字段）。**OP 11 HEARTBEAT_ACK** 直接忽略。出现 **OP 7 RECONNECT**、WebSocket `close`、或心跳超时未收到 ACK 时，进入重连流程：先销毁旧连接与定时器，按指数退避（初始 1s，上界 30s，含抖动）重试，重连成功后重新 IDENTIFY（RESUME 为可选项，本实现不做），`heartbeat_interval` 与 `lastSeq` 一并重置。

## 入站消息事件
只监听 **OP 0 DISPATCH** 中 `t === "MESSAGE_CREATE"` 的事件，其 `d` 形如 `{ id, channel_id, guild_id?, author:{id, bot?}, content, mentions? }`。过滤规则：`author.bot === true` 忽略；`content` 为空或非字符串忽略。取 `senderId = author.id`，回复通道为 `channel_id`。

## 回复（出站）
回复调用 REST：`POST https://discord.com/api/v10/channels/{channel_id}/messages`，请求头 `Authorization: Bot <token>`、`Content-Type: application/json`，正文 `{ content }`。Discord 单条消息上限 2000 字符，超出时截断。回复失败仅记日志，不抛出异常。

## 凭据
`token`（DISCORD_TOKEN）与 `enabled` 均来自运行时配置，绝不硬编码；日志仅输出“已配置/未配置”状态，不输出 token 明文。
