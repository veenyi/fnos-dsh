# 企业微信（WeCom）IM 渠道协议说明

> 插件：`@deepseek-ai/dsh-channel-wecom`
> 形态：企业微信 IM 渠道插件，出站完整、入站尽力实现（本机桌面场景）。

## 一、官方文档 URL

- 群机器人 webhook 发送消息：https://developer.work.weixin.qq.com/document/path/91770
- 应用接收消息（回调配置）：https://developer.work.weixin.qq.com/document/path/90930
- 回调和回复的加解密方案：https://developer.work.weixin.qq.com/document/path/101033
- 加解密方案说明（EncodingAESKey/AES-256-CBC）：https://developer.work.weixin.qq.com/document/path/96211
- 应用消息接口（发送消息）：https://developer.work.weixin.qq.com/document/path/96681
- 获取访问凭证 access_token：https://developer.work.weixin.qq.com/document/path/94666

## 二、出站：群机器人 webhook（完整实现）

- 端点：`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>`
- 请求体：`{ "msgtype": "text", "text": { "content": "<文本>" } }`
- 成功判定：返回 `{ "errcode": 0 }`。
- `webhookKey` 兼容两种写法：若为完整 URL（`http(s)://` 开头）直接作为端点使用；否则拼接为默认 URL + `?key=<webhookKey>`。
- 暴露 `pushText(text)` 供上层（定时任务、其他插件）调用；同时通过 `ctx.provide("wecomPush", pushText)` 注册为 ctx 服务。导入/调用失败只记日志，不影响 dsh 启动。

## 三、入站：本地 HTTP 回调接收器（尽力实现，本机桌面场景）

> 企业微信应用回调要求公网 URL；本机仅提供本地接收器（`127.0.0.1:<callbackPort>`，默认 9001），
> 需由 ngrok/内网穿透工具将本地端口映射到公网并填入企业微信回调配置，才能实际生效。
> 若未配置回调凭据（`corpId/agentId/secret/callbackToken/encodingAESKey`），插件仅启用出站推送模式并 log 说明入站未启用。

### 1. 验签 GET（验证 URL）

- 企业微信以 `GET <URL>?msg_signature=...&timestamp=...&nonce=...&echostr=...` 校验 URL。
- 计算签名：将 `Token、timestamp、nonce、echostr` 四个字符串按字典序排序后拼接，再做 `SHA1`，得到 `msg_signature`。
- 校验通过后，用 `EncodingAESKey` 解密 `echostr`（AES-256-CBC），把解密出的明文回显给企业微信。

### 2. AES 加解密（回调与回复）

- 算法：`aes-256-cbc`，PKCS7 填充。
- 密钥：`EncodingAESKey` 经 Base64 解码得到 32 字节，取前 32 字节作为 key，前 16 字节作为 iv（以官方加解密方案为准）。
- 加密：`AES加密(16字节随机串 + msg_body字节长度(4字节网络字节序) + msg_body + 企业微信CorpID)`，结果 Base64。
- 解密：Base64 解码 → AES 解密 → 去掉 16 字节随机前缀 → 按 4 字节网络字节序长度字段切出 msg_body。

### 3. POST 解密与回复

- 企业微信以 `POST` 推送加密 XML：`<xml><MsgSignature>...</MsgSignature><TimeStamp>...</TimeStamp><Nonce>...</Nonce><Encrypt>...</Encrypt>...</xml>`。
- 先按 GET 同样的 `SHA1(sorted(...))` 验签 `MsgSignature`，再解密 `<Encrypt>` 中的 XML。
- 解析明文 XML，仅处理 `MsgType=text` 的消息，取 `<Content>` 文本，交给 `handleMessage(senderId=FromUserName, text, replyFn)`。
- 回复走应用消息接口：
  - 获取 token：`GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=<CORP_ID>&corpsecret=<SECRET>`，缓存 7200s。
  - 发送：`POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=<token>`，body `{ "touser": <FromUserName>, "msgtype": "text", "agentid": <AGENT_ID>, "text": { "content": <文本> } }`。

## 四、通用约束

- ESM；零新增 npm 依赖，仅用 Node 内置 `http / crypto / fetch`。
- 凭据全部来自 `config`，绝不硬编码；日志只输出"已配置/未配置"，不输出任何凭据或 Token。
- 同 sender 并发用 busy Set 排队；会话用 `SessionId("wecom-<senderId>")`；回复提取复用 `extractReply`。
- 日志统一 `ctx.logger?.(name) ?? console`；导入与监听失败只记日志，不抛错、不阻塞 dsh 启动。
