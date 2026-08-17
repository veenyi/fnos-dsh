# dsh-channel-feishu 协议文档

飞书（Feishu/Lark）IM 渠道插件采用**长连接（WebSocket 出站）**模式，机器人主动与飞书开放平台建立 WebSocket 长连接，无需公网回调地址，适用于 DSH Desktop 这类 Electron 桌面应用的内网/桌面部署场景。

## 1. 鉴权：tenant_access_token

机器人所有 API 调用均使用 `tenant_access_token`（而非 user_access_token）。获取方式：

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
Content-Type: application/json

{ "app_id": "<appId>", "app_secret": "<appSecret>" }
```

响应 `code=0` 时 `tenant_access_token` 字段即为令牌。凭据字段：`appId`（对应 `FEISHU_APP_ID`）、`appSecret`（对应 `FEISHU_APP_SECRET`），**仅从 config 读取，绝不硬编码**，日志只输出"已配置/未配置"。

> 官方文档：<https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token>

## 2. 长连接端点与建立连接

获取一次性长连接地址：

```
POST https://open.feishu.cn/open-apis/ws_endpoint
Content-Type: application/json

{ "app_id": "<appId>", "app_secret": "<appSecret>" }
```

响应 `data` 含 `url` 与 `ticket`。连接时用 Node v24 内置的 `globalThis.WebSocket`（零新增依赖），URL 拼为 `<url>?ticket=<ticket>`（注意 query 分隔符）。

> 官方文档（使用长连接接收回调）：<https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM.md?lang=zh-CN>
> 订阅模式与请求地址配置：<https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md>

## 3. 注册与心跳

WebSocket `open` 后，客户端立即发送注册帧：

```json
{ "type": "client_register", "client_type": 4 }
```

服务端会周期性发送心跳相关帧（如 `{"type":"pong"}` / ping 类），客户端无需主动回复 ping，收到 `pong` 即视为链路存活，忽略即可；连接断开后按指数退避（1s 起步，上限 60s）重新获取 `ws_endpoint` 再连，`token` 提前刷新避免重连时过期。

## 4. 入站事件监听

正常数据帧形如：

```json
{ "type": "data", "data": "<JSON 字符串>" }
```

`data` 是字符串需 `JSON.parse`。解析后当 `event.type === "im.message.receive_v1"` 时为机器人收到文本消息事件：

- 发送者 `sender_id`：`event.sender.sender_id.open_id`，作为 `senderId`；
- 会话 `chat_id`：`event.message.chat_id`（日志上下文）；
- 文本：`event.message.message_type === "text"` 时，`event.message.content` 为 JSON 字符串 `{"text":"..."}`，需二次 `JSON.parse` 取 `text`。

每个 `senderId` 对应一个持久 dsh session（`SessionId("feishu-<senderId>")`），同 `sender` 并发用 `busy Set` 排队，进行中回复"[系统] 上一条消息还在处理中，请稍后再发。"。

## 5. 回复消息

把最终 assistant 回复回传原会话：

```
POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id
Authorization: Bearer <tenant_access_token>
Content-Type: application/json

{
  "receive_id": "<open_id>",
  "msg_type": "text",
  "content": "{\"text\":\"<回复文本>\"}"
}
```

`content` 需 `JSON.stringify({ text: <文本> })`；回复超长时截断到 6500 字符。回复提取复用钉钉模板 `extractReply`（遍历 session.events 取最后一个非空 assistant 文本块）。

> 官方文档（发送消息）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create.md?lang=zh-CN>
> 消息内容描述：<https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md>

## 6. 错误处理与降级

导入/连接失败只记日志不抛错（参考钉钉 `import("dingtalk-stream")...catch` 模式）；本插件无可选动态导入，WebSocket 创建、注册、`fetch` 调用均 `try/catch` 记日志后重连或忽略。
