# Blender CLI 与 MCP 联动

工作台继续使用本机 Blender 4.5 LTS CLI 执行建模 Python、验证文件并导出 GLB。MCP 连接额外的 Blender GUI 工作副本，支持场景读取、截图、位置/旋转/缩放与基础材质调整，以及手工编辑后的版本同步。

## 安装和使用

运行 `npm run setup:blender-mcp`。安装器将 uv、Python 虚拟环境及 `blender-mcp==1.9.1` 放入 `data/blender-mcp-runtime`，校验发布包中的插件与 GitHub commit `5f8ddaf6e987c4aa0c3467fcc548838b28f64477` 的 SHA-256 一致。不修改全局 Codex 配置、认证或用户 Blender 插件设置。

1. 打开已保存作品，点顶部 **Blender → 在 Blender 中打开**。
2. 工作台启动独立 Blender 窗口、打开 `.blend` 工作副本，在独占 `127.0.0.1` 端口启用上游插件。
3. 连接后，网页变换/基础材质调整通过 MCP 执行并自动保存新版本。也可选中对象，在 Blender 面板输入“放大 10%”等局部调整。
4. 在 Blender 中手动编辑后，点击 **同步回工作台**。支持的对象仍按现有工作台场景格式导出；不支持的 Blender 内容会报错，工作副本保留。
5. 可以在网页撤销、重做。网页版本变化后，旧 Blender 工作副本不能直接覆盖新版本；先在 Blender 另存自己的修改，再断开、重新打开网页当前版本。

断开只关闭 MCP 客户端，保留 Blender 窗口及工作副本；可用面板中的“恢复 Blender 窗口”重新连接。服务重启后也可以重新连接记录的工作副本。断线/取消导致执行结果不确定时，不自动重放；先重新连接读取实际场景，再同步。

## 接口与执行范围

- `GET /api/blender/status`：运行时、连接、作品和基准版本状态。
- `POST /api/projects/:id/blender/open|reconnect|disconnect`：打开/重新连接/断开。
- `POST /api/projects/:id/blender/recover`：提交 `{sessionId}`，恢复已断开的原工作副本。
- `GET /api/projects/:id/blender/scene|screenshot`：读取实际场景/视口截图。
- `POST /api/projects/:id/blender/sync`：提交 `{baseRevisionId}`，返回现有任务对象。
- `POST /api/projects/:id/blender/edit`：提交 `{baseRevisionId,objectId,prompt}`，将明确的局部调整转换成受限命令并同步。
- 现有 `/commands` 的 transform/material 在已关联 Blender 时走 MCP；其他命令继续 CLI。版本不一致或连接失效时不会静默改用另一个执行器。

后端通过 MCP SDK 的 `listTools`、`callTool` 调用上游 `get_scene_info`、`get_viewport_screenshot`、`execute_blender_code`。网页不接受任意 Python；几何生成脚本仍在原 CLI 沙箱执行。所有 API 沿用本地会话、Host 与来源检查。

MCP server 启动时设置 `DISABLE_TELEMETRY=true` 与 `BLENDER_MCP_SAFE_MODE=true`。Blender 插件仅绑定 loopback，外部素材/生成集成关闭。上游插件 socket 不提供认证；safe mode 是语法限制，不是操作系统文件沙箱。MCP 只用于本机工作台，不暴露局域网。

## 文件与验收

- `data/blender-sessions/<sessionId>/working.blend`：可编辑工作副本及独立 Blender 资源目录。
- `data/jobs/<jobId>/attempt-0/raw.blend`：实际同步候选；失败时保留。
- `data/jobs/<jobId>/attempt-0/before-normalize.blend`：为手动新增对象分配工作台 ID 之前的场景备份。
- `data/revisions/<revisionId>`：已有的不可变 `.blend`、GLB、场景摘要和脚本版本。

`ZAOWU_DATA_DIR="$PWD/data/mcp-proof" npx tsx scripts/verify-blender-mcp.ts` 使用确定性脚本、真实 CLI 和真实 MCP，验证创建、读取、修改、材质、截图、同步、撤销/重做与重连。结果写入独立目录的 `acceptance.json`，不修改用户作品。
