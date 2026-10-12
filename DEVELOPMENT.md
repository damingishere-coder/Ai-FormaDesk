# 开发指南

本文对应 FormaDesk 1.1。历史需求草案归档于 [最初设计](docs/archive/INITIAL-DESIGN.md)，不作为当前功能或验收证明。用户安装和操作见 [文档中心](docs/README.md)。

## 准备与启动

需要 Node.js 22+；桌面构建需要 Apple Silicon Mac。Blender 4.5 LTS 和已登录的 Codex CLI 分别安装，工作台不修改全局模型提供商和认证配置。

```sh
npm ci
npm run desktop:dev
```

网页开发使用两个终端分别运行 `npm run dev` 和 `npm run dev:web`，默认后台 8765、Vite 5173。用 `ZAOWU_DATA_DIR` 指定独立测试数据目录；不要用真实作品做故障注入。其他路径变量见 [工作台配置](docs/WORKBENCH.md#本地配置与开发)。

## 代码导航

| 目录或文件 | 职责 |
| --- | --- |
| `desktop/` | Electron 窗口、菜单、下载、后台生命周期 |
| `src/App.tsx`、`src/ProjectLibrary.tsx` | 编辑工作台与作品首页 |
| `src/Viewport.tsx`、`src/thumbnailFraming.ts` | 实时画布、坐标转换与封面取景 |
| `server/index.ts`、`server/store.ts` | HTTP / SSE 接口、持久状态 |
| `server/jobs.ts`、`server/process.ts` | 任务、进程与执行边界 |
| `server/project-files.ts`、`server/library-cache.ts` | 文件归属与 Blender 作品缓存 |
| `server/codex.ts`、`server/protocol/` | Codex App Server 适配及生成协议 |
| `blender/` | 建模、验证、材质、渲染与可选插件 |
| `tests/`、`scripts/` | 单元测试、界面回归、真实 Blender / 桌面验证 |

已保存 `.blend` 是场景依据，GLB 和清单是派生结果。每次编辑带 `baseRevisionId`；只有执行与验证成功才更新版本。保留对象稳定 ID、旧版本、失败信息以及既有场景灯光。

## 验证

```sh
npm test
npm run build
npm audit --omit=dev --audit-level=high
python3 tests/plugin-source-open.py
python3 tests/scene-tree.py
node scripts/verify-browser-safety.mjs
npm run test:browser
# test:e2e 也是同一安全 mock 入口
npm run test:e2e
```

`test:browser` / `test:e2e` 默认只跑安全 mock UI 回归。Playwright 自动启动本源码的独立 Vite（默认 `127.0.0.1:19143`），没有后台代理、不打开 SQLite、不启动 Codex/Blender，也不复用用户已有服务。端口占用会拒绝启动；并行验证可设置另一个 `FORMA_MOCK_PORT`，不能使用常用服务端口 8765/5173。

所有安全 spec 使用 `tests/browser/fixtures.ts` 的 `test/expect`。只 mock 明确 API 契约；未 mock 请求、外部请求和直接 `page.request`/`request` 调用会失败。Vite 对漏过路由的 `/api` 也拒绝，避免连到用户后台。不要用通用 `{}` 回应未知接口来让测试通过。`verify-browser-safety.mjs` 在临时目录中检查这些请求与危险 live 配置确实被拒绝；不会执行真实后台验收。UI mock 证明界面与请求契约，不证明真实 AI、Blender 或产物质量。`scene-tree.py` 单独执行真实 Worker 命令分支的内存夹具，验证深树/删除顺序/稳定 ID，不读取用户场景。

```sh
# 只跑指定 UI 回归；仍自动使用独立 Vite 与网络护栏
npm run test:browser -- tests/browser/preview-progress.spec.ts
```

真实后台验收独立使用 `playwright.live.config.ts`；必须显式 opt-in、独立临时 DATA 和后台 URL。配置会启动本源码后台，`reuseExistingServer=false`，不能接到正在使用的桌面/后台。先完成 build，再准备本轮所需独立样例；历史 V1/V2/V3 spec 的旧交互与前提仍需按当轮验收范围核对，不能只因护栏通过就声称 live 全链路通过。默认不会运行读取历史 GLB 的 `@asset` 验收。

```sh
FORMA_LIVE_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/formadesk-live-XXXXXX")"
export FORMA_LIVE_DATA_DIR
export FORMA_LIVE_TESTS=1
export FORMA_LIVE_URL=http://127.0.0.1:19145
npm run build
npm run test:browser:live -- tests/browser/render.spec.ts
# 包含 generate/discuss 的真实 AI 验收还需主动设置 FORMA_REAL_AI=1，会消耗额度。
```

真实验收证据统一写入该临时 DATA 的 `browser-evidence/`，不写默认 `data`。未显式开启 live、DATA 非独立临时目录、URL 指向常用服务端口时会直接拒绝。

```sh
npm run desktop:dist
FORMA_DESKTOP_EXECUTABLE="$PWD/release/mac-arm64/Ai-FormaDesk.app/Contents/MacOS/Ai-FormaDesk" \
FORMA_DESKTOP_MINIMAL_PATH=1 FORMA_DESKTOP_FULL=1 npm run test:desktop
```

桌面测试会把 `.app` 复制到源码目录之外，使用独立数据创建真实 Blender 场景并验证导出、录制、进程退出和重启。实际验收记录见 [1.1.0](docs/releases/1.1.0.md)。

## Git 与发布

- `main` 保存已经整合的稳定代码；正式功能与修复使用独立 `codex/*` 分支。
- 已通过验证的改动提交 PR，CI 和仓库要求通过、无冲突后合并。实验分支的验收状态见 [分支说明](docs/BRANCHES.md)。
- 同步根包、锁文件和 `desktop/package.json` 的版本，更新 CHANGELOG 与发布说明。
- 干净提交构建 DMG / ZIP，完成独立安装包测试，再从对应提交发布版本标签、安装包、SHA-256 与构建信息。
- 不提交运行数据、认证配置、日志、缓存或安装包。安装包放 GitHub Releases。

现有发布目标为 GitHub Releases，仓库没有独立网站生产部署。CI 验证构建与生产依赖审计；手动 macOS workflow 可产出安装包，不会自动创建 Release。
