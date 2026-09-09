# macOS 桌面应用

## 安装

从仓库 Releases 下载 `Ai-FormaDesk-1.0.0-macOS-arm64.dmg`，打开后将应用拖入“应用程序”。应用包内包含界面、Electron、Node.js 22 与后台依赖，不依赖本机源码目录或 npm。

需要 Apple Silicon Mac、macOS 13 或以上。请另行安装 Blender 4.5 LTS 与已经登录的 Codex CLI。默认 Blender 路径为 `/Applications/Blender 4.5 LTS.app/Contents/MacOS/Blender`；其他位置可通过应用菜单设置。

### 首次打开

1.0 未使用 Apple Developer ID 签名与公证。如果 macOS 阻止打开，先确认安装包来自本仓库 Release 并核对 SHA-256，然后尝试打开一次，再到“系统设置 → 隐私与安全性”查看该应用的“仍要打开”。若系统未提供该按钮，请保留具体提示并提交 Issue。不要关闭系统整体安全保护。

## 已有作品

1. 在旧工作台里保存操作，退出旧的后台服务。
2. 打开桌面应用，选择“ Ai-FormaDesk → 使用现有作品数据文件夹…”。
3. 选择原项目中包含 `index.sqlite` 的 `data` 文件夹。
4. 退出并重新打开应用。

文件不移动、不删除。现有数据中包含绝对路径，因此必须保留原数据目录。若目录被其他工作台使用，桌面应用会拒绝启动该后台，以免两个服务同时恢复或修改任务。

默认的新数据目录是 `~/Library/Application Support/Ai-FormaDesk/data`。桌面路径设置存放在同级 `desktop-settings.json`；覆盖安装不会覆盖作品和设置。

## 窗口和退出

- 红色关闭按钮关闭窗口，应用仍留在程序坞；点击图标或“窗口 → 显示工作台”重新显示。
- `⌘Q` 或应用菜单“退出”结束应用并停止后台。正在执行的工作台任务会被取消，已保存版本保留。
- 文件导出使用 macOS 保存对话框，支持模型、PNG、实时录制视频和精细视频。
- “视图 → 重新载入”只重新加载界面。
- “打开应用日志文件夹”可查看当前运行的 `backend.log`。分享前请检查私人路径和内容。

Blender MCP 打开的外部 Blender 编辑窗口由用户管理，退出工作台会断开联动，不会强制关闭尚可能有未保存编辑的 Blender 窗口。

## 可选 Blender MCP

普通建模和导出不依赖 MCP。联动需要另行准备已验证的 Blender MCP 1.9.1 运行时，见 [接入文档](BLENDER-MCP.md)。如果原工作台已经安装，在应用菜单“设置 Blender MCP 运行时…”选择原来的 `data/blender-mcp-runtime`。

## 开发与构建

```sh
npm ci
npm run desktop:prepare   # 前端 + 后台 bundle + 校验并下载固定 Node.js + npm ci --omit=dev
npm run desktop:dev       # 构建并打开独立窗口
npm run desktop:pack      # 输出 release/mac-arm64/Ai-FormaDesk.app
npm run desktop:dist      # 输出 .app、DMG、ZIP
npm run test:desktop      # 开发版桌面冒烟验收
python3 scripts/install-mac-app.py  # 本机安装到 ~/Applications 并更新程序坞
```

构建运行于 Apple Silicon Mac。`scripts/build-desktop.mjs` 固定 Node.js 版本和 SHA-256；Electron 与 electron-builder 版本固定在锁文件。后台使用独立 Node 进程运行，原生 SQLite/sharp 模块使用 Node ABI，避免与 Electron ABI 混用。

应用资源在 `Contents/Resources/runtime`，数据在用户目录。界面加载应用私有的回环服务，随机端口由后台通过 IPC 返回；只有桌面会话会附带随机访问凭据。浏览器不会自动打开。

```sh
# 按指定路径继续使用旧作品；先退出旧后台
python3 scripts/install-mac-app.py --data-dir /absolute/path/to/data
```

安装器只覆盖本项目已知应用标识，先备份旧入口和 Dock 配置，不改变其他程序坞应用。源码目录中的旧 `.command` 仍保留为开发入口。
