# 旧验收脚本的安全入口

这些脚本保留原有场景、算法与断言，本轮只保护入口和输出路径。它们不属于默认 mock 浏览器验收，也没有因此获得真实 AI、Blender、MCP 或桌面全流程验收结论。缺授权时会在导入后台/数据库模块、启动工具或连接 HTTP 前退出。

所有脚本必须同时满足：

- `FORMA_LIVE_TESTS=1`。
- `ZAOWU_DATA_DIR` 是用 `mktemp -d` 新建的系统临时目录，名称以 `formadesk-live-` 开头；必须是实际目录和绝对路径，不能使用用户作品、源码下的 `data` 或目录符号链接。
- AI 脚本另需 `FORMA_REAL_AI=1`。
- HTTP/浏览器脚本另需显式 `FORMA_LIVE_URL`：仅允许 `http://127.0.0.1:<独立端口>`，禁止 8765、5173 和 mock Vite 端口。该临时 DATA 的 `project-library/index.json` 必须与地址和实际 DATA 匹配；不能仅凭一个可访问 URL 连接现有用户后台。

修改清单与附加条件：

| 脚本 | 真实 AI | HTTP/浏览器 | 前置条件或行为 |
| --- | --- | --- | --- |
| `verify-preview-fast.ts` | 否 | 否 | 参数为只读 `.blend` 输入；结果写临时 DATA。 |
| `verify-visual-preservation.ts`、`verify-visual-blender.ts` | 否 | 否 | 在临时 DATA 创建确定性 Blender 夹具。 |
| `verify-image-composition.ts`、`integration.ts` | 否 | 否 | 保留真实 Blender/环境检查，不覆盖调用者 DATA 设置。 |
| `visual-fixtures.ts` | 否 | 否 | 共享夹具模块，单独执行也有护栏；类别与目标目录受限制。 |
| `verify-threeview-live.ts`、`compare-threeview.ts` | 是 | 否 | 临时 DATA 的三视图夹具与结果。 |
| `verify-visual-cli.ts`、`verify-visual-transport.ts` | 是 | 否 | 真实模型/图片工具调用，需要第二层授权。 |
| `verify-v2.ts` | 是 | 是 | 连接绑定该 DATA 的隔离后台。 |
| `verify-v3-video.ts`、`verify-v3-boundaries.ts` | 否 | 是 | 同一隔离后台产生的 `v3-evidence/recording.json` 与录制文件。 |
| `gizmo-drag.ts` | 否 | 是 | 同一隔离后台产生的 `acceptance/drag-seed.json`。 |
| `capture-delivery.ts`、`verify-object-actions.ts` | 否 | 是 | 同一隔离后台产生的 `acceptance/final-scene.json`；截图仅写临时 DATA。 |
| `verify-single-pass-live.ts` | 是 | 是 | 必须显式设置当前临时 DATA 内的 `FORMA_COMPARISON_JOB`；不再有历史任务默认 ID。 |
| `verify-blender-mcp.ts` | 否 | 否 | 本轮原有确定性生成夹具，仍会开启真实 Blender/MCP。 |
| `verify-blender-mcp-boundaries.ts` | 是 | 否 | 同一临时 DATA 中先完成 MCP 验收；包含真实自然语言修改。 |
| `fault-checks.ts` | 否 | 自启 | 前置已保存夹具；只启动自己的子后台，使用端口 0，并等待该子进程的 ready IPC 后使用实际端口，不探测固定地址。 |

`check:environment`、运行时/插件安装和 token 补记是显式维护命令，沿用 DATA 所有权锁，不改成 live 验收命令。桌面验收使用自身的独立临时 home/fixture 校验。

## 安全运行示例

在第一个终端新建隔离目录，并运行不调用 AI 的确定性 Blender 验收：

```sh
export ZAOWU_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/formadesk-live-XXXXXX")"
export FORMA_LIVE_TESTS=1
unset FORMA_REAL_AI
npx tsx scripts/verify-image-composition.ts
```

结果留在该目录。其他脚本如需旧夹具，必须先在**同一隔离目录和后台**创建它们；不要拿历史项目 ID 指向日常后台。当前目录下的数据库不能同时由独立 CLI writer 和后台进程占用，应等待 CLI 退出再启动后台。

HTTP 示例需要第二个终端启动源码后台；两个终端使用同一个新建临时目录的绝对路径：

```sh
export ZAOWU_DATA_DIR="/absolute/path/to/formadesk-live-XXXXXX"
export FORMA_LIVE_TESTS=1
export ZAOWU_PORT=19145
npm run start
```

后台 ready 后，在验收终端使用相同 DATA，并显式授权真实 AI 才可运行 V2 脚本：

```sh
export FORMA_LIVE_URL=http://127.0.0.1:19145
export FORMA_REAL_AI=1
npx tsx scripts/verify-v2.ts
```

此命令会真正调用 AI。guard 的负向验证不需要这些授权，也不会运行真实验收：

```sh
npx vitest run tests/live-script-guards.test.ts
```

本轮验证仅证明缺授权、错误目录、缺 AI 授权、缺/错误 URL 等路径会被拒绝，以及正常所有权测试仍通过；没有执行上述真实 live 命令。历史 UI 选择器和场景前提仍需后续真实验收确认，不能把入口保护通过当作这些旧场景已全部通过。
