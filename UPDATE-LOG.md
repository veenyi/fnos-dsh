# DeepSeek Harness (fnos-dsh) 更新日志

## v0.1.17 (2026-08-14) — 修复插件配置页空白（真正根因）
- 真正根因：settingsScope 的 persistence 由 `connection.isLoopback ? "host" : "memory"` 决定；
  LAN 访问 isLoopback=false → memory 模式 → store 初始 status="unavailable" 且 enqueue 直接 return（read 不执行），
  导致插件配置 3 卡片（Bash/AgentLoop/WebSearch）永远空白。
- 修复：dsh-client-ui-settings 210 行改固定 "host"（局域网也走 host 持久化）

## v0.1.16 (2026-08-14) — 补充 mux 通道特权放宽（非本次根因，但同类 loopback 限制）
- client-connection 237/243 行 mux/register 通道 loopback-only 特权检查改传 this.trustedHosts

## v0.1.15 (2026-08-14) — IM 驱动对话（阶段 1：钉钉渠道骨架）
- 新增：钉钉 Stream 渠道插件 @deepseek-ai/dsh-channel-dingtalk（单聊 MVP）
- 架构：dsh Cordis 插件，注入 agents/sessions/agentDefaultModel，参考 dsh-headless 驱动对话
- 消息流：钉钉 Stream 收消息 → agents.create/followup/whenIdle → 提取 assistant 文本 → sessionWebhook 回传
- 关键坑：loader 从 profile 目录(data/profiles/web)解析插件依赖，须软链 data/node_modules → target/node_modules
- 凭据：通过环境变量 DINGTALK_APP_KEY/SECRET 注入（cmd/main 从 data/.env source），patch 里 !!js 读取，不硬编码

## v0.1.13 (2026-08-13) — 插件可视化启停
- 新增：插件列表卡片展开后可「启用/停用插件」按钮，运行时生效并持久化到 cordis.patch.yml
- 实现：服务端 dsh-host-plugin-inventory 增加 setEnabled Remote 方法（loader.update 改 disabled）；
  客户端 dsh-api-remotes 补 setEnabled 的 typert descriptor（编译时 face 需 parameters+result schema）；
  前端 ui-settings-plugin-inventory 加 toggle 按钮
- 注意：pluginInventory 的 RPC 走 WebSocket mux 通道（非 POST），curl 测 /api/pluginInventory.list 返回 404 属正常

## v0.1.8 (2026-08-13) — 全面审查修复
- 隐私（critical）：去除 patch-web.yaml 内网 IP 硬编码（依赖 dsh 绑定 0.0.0.0 时自动发现 LAN IP）
- 功能 bug：修复 install_callback 凭据格式（KEY=value → YAML 的 KEY: value），向导填的 DeepSeek key 此前无法被 dsh 读取
- 工具脚本隐私：upgrade-fnos-dsh.cjs / askpass.cmd 密码与本地路径全部参数化（环境变量），废弃 deploy-fnos-dsh.cjs

## v0.1.7 (2026-08-13)
- 汉化：斜杠命令菜单全部描述（compact/export/feedback/goal/permission/plan），
  覆盖服务端插件（dsh-command-* / dsh-permission-presets / dsh-plan-mode / dsh-session-log-export）
  与客户端副本（dsh-client-connection）；输入区权限指示改用中文（permissionValueLabel）

## v0.1.6 (2026-08-13)
- 汉化：权限选项（只读 / 工作区写入 / 完全访问）——官方硬编码英文不走 i18n，
  定制 dsh-client-ui-conversation optionLabel 与 dsh-client-ui-permission-presets displayPermissionPreset 增加中文映射

## v0.1.5 (2026-08-13)
- 修复（关键）：dsh 对特权方法（settings.describe / credentials.describe / llm.discoverModels /
  agentPreset.read 等配置类 API）强制 loopback-only（官方安全设计，即使配置 trustedHosts 也 403），
  导致局域网访问时设置/模型/插件配置/Agent 预设页全部 403。
  处理：定制 client-connection（lib/index.js 538 行）特权检查传 trustedHosts（LAN IP 自动加入 +
  patch 显式声明），局域网可正常配置；会话/聊天等普通方法不受影响。

## v0.1.4 (2026-08-13)
- 修复：cmd 脚本权限统一 755（chmod 700 导致 appcenter 以应用用户执行 start 失败）
- 升级链路固化：upgrade-fnos-dsh.cjs 远端解包 + 双路径覆盖 + cmd 权限修复

## v0.1.3 (2026-08-13)
- 修复：Windows 打包的 cmd 脚本 cp 后丢失执行位，install/upgrade 回调统一 chmod 755

## v0.1.2 (2026-08-13)
- 修复（关键）：HTTP LAN 访问（非安全上下文）下浏览器不提供 crypto.randomUUID，
  导致设置/模型/工作区/Agent 预设等前端模块崩溃 —— 在 index.html 注入 UUID v4 polyfill

## v0.1.1 (2026-08-13)
- 修复：watchdog 崩溃自愈增加数据目录权限修复（chown 对齐应用属主），防止数据目录属主错乱导致 EACCES 崩溃循环
- 部署：249 覆盖升级（target + 壳目录双路径）

## v0.1.0 (2026-08-13)
- 首个飞牛 NAS 版本：DeepSeek AI 官方开源 Agent Harness（dsh 0.1.0-rc.6）打包
- 自带完整 Web UI 工作台（端口 3080）：Agent 聊天、工具调用、技能、多会话
- 预置双模型提供方：DeepSeek 官方 + 聚合网关（token.sensenova.cn，免费模型开箱即用）
- 捆绑 Node.js 22.23.2 linux-x64 运行时，自包含安装
- watchdog 常驻守护：进程崩溃自动重启
- 安装向导支持填写 DeepSeek API Key；完成弹窗展示访问地址
- 卸载可选保留/清除数据（会话、配置、API Key）
