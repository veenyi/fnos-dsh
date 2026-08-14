#!/bin/bash
# fnos-dsh 定制补丁应用脚本（构建时运行，npm install 之后）
# 把修改后的 node_modules 定制文件覆盖到安装产物，并装入自定义插件。
set -e
cd "$(dirname "$0")"

echo "[patches] applying fnos-dsh customizations ..."

# 1) 覆盖定制文件（汉化 / 特权放宽 / randomUUID polyfill / 插件启停等）
if [ -d "patches/files/node_modules" ]; then
  cp -r patches/files/node_modules/* node_modules/
  echo "[patches] node_modules overrides copied"
fi

# 2) 装入自定义插件（钉钉 IM 渠道，位于 app/plugins/）
if [ -d "plugins/dsh-channel-dingtalk" ]; then
  mkdir -p node_modules/@deepseek-ai
  cp -r plugins/dsh-channel-dingtalk node_modules/@deepseek-ai/
  echo "[patches] plugin dsh-channel-dingtalk installed"
fi

# 3) 生成 FPK 用的 app.tgz 内容就绪检查
[ -f "node_modules/@deepseek-ai/dsh/lib/bin.js" ] && echo "[patches] dsh entry verified"

echo "[patches] done"
