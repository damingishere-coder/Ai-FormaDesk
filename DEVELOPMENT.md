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
```

`npm run test:browser` 包含多种测试，部分会调用真实 AI、消耗额度。为 UI 回归选择具体 spec，并连接本次构建的独立服务，不能把用户正在使用的旧服务当成本次代码。模拟接口测试仅证明界面行为。

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
