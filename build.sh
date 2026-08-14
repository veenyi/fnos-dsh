#!/bin/bash
# DeepSeek Harness (fnos-dsh) 一键打包脚本
# 用法：在本目录（fnos-dsh/）运行；产物 → pkg/fnos-dsh_v<版本>.fpk
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || { echo "dir missing"; exit 1; }

echo "===== [1] 运行资源断言 ====="
for req in "$DIR/app/bin/node" "$DIR/manifest" "$DIR/ICON.PNG" "$DIR/ICON_256.PNG" \
           "$DIR/cmd/main" "$DIR/cmd/install_callback" "$DIR/cmd/upgrade_init" \
           "$DIR/wizard/install" "$DIR/config/privilege" "$DIR/config/resource" \
           "$DIR/app/ui/config" "$DIR/app/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  if [ ! -e "$req" ]; then echo "FATAL: 运行资源缺失 $req"; exit 1; fi
done
echo "runtime resources verified"

echo ""
echo "===== [2] node_modules 就位检查 ====="
NMOD=$(ls "$DIR/app/node_modules" 2>/dev/null | wc -l)
echo "node_modules packages: $NMOD"
if [ "$NMOD" -lt 50 ]; then echo "FATAL: node_modules 不完整，请先同步 249 安装产物"; exit 1; fi

echo ""
echo "===== [3] manifest 版本确认 ====="
grep '^version' "$DIR/manifest"

echo ""
echo "===== [4] fnpack build ====="
FPACK="$(dirname "$DIR")/fnpack.exe"
[ -x "$FPACK" ] || FPACK="$(dirname "$DIR")/../../2026-08-02/chat-1/fnpack.exe"
"$FPACK" build --directory "$DIR" 2>&1 | tail -3

echo ""
echo "===== [5] 产物归档 ====="
VER=$(grep '^version' "$DIR/manifest" | awk '{print $3}')
mkdir -p "$DIR/pkg"
if [ -f "$DIR/fnos-dsh.fpk" ]; then
  mv -f "$DIR/fnos-dsh.fpk" "$DIR/pkg/fnos-dsh_v$VER.fpk"
  echo "归档: $DIR/pkg/fnos-dsh_v$VER.fpk"
  md5sum "$DIR/pkg/fnos-dsh_v$VER.fpk"
else
  echo "WARN: 未找到 fnos-dsh.fpk"
  ls -la *.fpk 2>/dev/null
fi
