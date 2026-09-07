#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="$HOME/.local/bin:$HOME/.local/codex-patch-runtime/node-v22.15.1-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print '需要 Node.js 22 或更高版本。请先安装 Node.js，再重新双击。'
  read '?按回车关闭…'
  exit 1
fi
if curl -fsS http://127.0.0.1:8765/api/session >/dev/null 2>&1; then
  open http://127.0.0.1:8765
  exit 0
fi
if [ ! -d node_modules ]; then
  print '正在安装本项目依赖…'
  npm ci
fi
if [ ! -f dist/index.html ]; then
  npm run build
fi
print 'Ai-FormaDesk 正在启动。请保留此窗口；按 Control+C 停止服务。'
( sleep 3; open http://127.0.0.1:8765 ) &
NODE_ENV=production npm start
