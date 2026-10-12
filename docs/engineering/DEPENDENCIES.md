# P2.2 依赖补丁交接（2026-10-12）

## 当前结论

- 官方 `npm audit --omit=dev`：**7 → 0**，最后一次 exit 0。
- 完整 `npm audit`：**20 → 11**，最后一次 exit 1。剩余 **2 critical + 9 moderate，0 high**，全部标为开发依赖链；未把残余风险改名为“无问题”。
- 依赖源码修改仅 `package.json` 的 3 个 dependencies 字段与 `package-lock.json`。本轮新增 scripts、devDependencies 与固定 Electron/build 工具版本保留；本轮同步 version 1.1.1 已确认。
- 没有 force、全量 audit fix、overrides、跨主版本工具迁移，也没有提交/推送/部署。

## 官方 registry 确认与实际安装

所有 `npm view`、安装和定向 update 使用 `https://registry.npmjs.org`。MCP 当前 latest 是 1.32.1，但公告影响 `<1.31.0`，选择已发布的最小安全 minor **1.31.0**；不存在 1.27.2，未虚构旧分支补丁。

| 依赖 | 原锁定版本 | 新锁定版本 | 包字段变化/所属 |
|---|---:|---:|---|
| Fastify | 5.12.3 | 5.12.5 | ^5.6.0 → ^5.12.5 |
| MCP SDK | 1.27.1 | 1.31.0 | ^1.27.1 → ^1.31.0 |
| sharp | 0.35.4 | 0.35.5 | ^0.35.4 → ^0.35.5 |
| proxy-addr | 2.0.7 | 2.0.8 | MCP → Express；只改锁 |
| fast-uri | 3.1.7 / 4.1.4 | 3.1.8 / 4.2.2 | MCP → AJV、Fastify JSON/compiler；只改锁 |
| ip-address | 10.7.0 | 10.7.4 | MCP → express-rate-limit；只改锁 |
| brace-expansion | 5.0.9 | 5.0.12 | static → glob/minimatch；只改锁 |
| brace-expansion（dev） | 1.1.18 / 2.1.4 | 1.1.21 / 2.1.7 | builder/glob 同名漏洞链的同主补丁 |
| http-cache-semantics（dev） | 4.2.0 | 4.3.0 | builder → @electron/get → got → cacheable-request；同主 |
| source-map-js（dev） | 1.2.1 | 1.2.2 | Vite → postcss；同主补丁 |

锁文件共 41 个版本条目变化，其中 26 个为 sharp 各平台 native/libvips optional 包；**没有新增或移除包条目**。所有余下变化均是上述明确命名依赖。当前本机 sharp native 0.35.5、libvips 8.18.7、rsvg 2.63.2。

保留并经 `npm ls` 确认：Electron **44.3.0**、electron-builder **26.15.3**、esbuild **0.28.2**、Vitest **3.2.7**。devDependencies 字段完全保留，没有升级无关开发工具。

执行的三个 mutation（全部已 exit 0，之后没有再改 node_modules）：

```sh
npm install fastify@5.12.5 @modelcontextprotocol/sdk@1.31.0 sharp@0.35.5 --no-audit --no-fund --registry=https://registry.npmjs.org
npm update fast-uri proxy-addr brace-expansion ip-address --no-audit --no-fund --registry=https://registry.npmjs.org
npm update http-cache-semantics source-map-js --no-audit --no-fund --registry=https://registry.npmjs.org
```

## 剩余 11 项：真实修复边界

### 1. Vitest / Tinypool：2 critical + 1 moderate

- 条目：`vitest@3.2.7`（critical，包含传递风险）、`tinypool@1.1.1`（critical）、`@vitest/mocker@3.2.7`（moderate）。不是 3 个互不相关的业务漏洞。
- 调用路径：`npm test` → Vitest → Tinypool worker pool / mocker。生产 `src/server/desktop/scripts` 没有直接导入 Tinypool、mocker 或 sprintf，`vitest.config.ts` 仅 Node 单测 include，Vite 只配置 React/plugin/proxy，未接入公开 mocker 插件。
- Tinypool 触发条件：其他代码先污染 Object.prototype 的 worker 选项或 run options，随后创建/运行 worker，可让 worker 加载攻击者代码。两个公告的合并安全边界是 **Tinypool ≥2.1.2**。[worker 选项公告](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[run options 公告](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)。本轮没有做利用尝试，也没有证明整个开发机不存在上游原型污染。
- Mocker 触发条件：独立公开 mocker/interceptor 插件的 HMR WebSocket 收到可越界 redirect；Vitest 自己的 browser RPC 有 token，不能把所有 browser mode 都等同未认证读取。当前项目没启用这条公开插件路径。修复最小是 **Vitest/mocker 4.1.11**；官方说明 3.x 不维护且不回补。[公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)
- 官方 npm registry：Vitest 3.x 最后发布为 **3.2.7**，其依赖固定 mocker 3.2.7、Tinypool ^1.1.1；Tinypool 1.x 最后为 1.1.1，**不存在可直接同主更新的安全版**。
- 可行后续轮次：单独迁移 **Vitest 4.1.11**（registry 已确认支持 Node ^20/^22/≥24，依赖 mocker 4.1.11，已经不依赖 Tinypool），验证全部 unit/coverage/config/pool/全局状态隔离。npm audit 自动建议 **Vitest 5.0.3**，但不是本轮必须采用的最小方案。两条路都属于测试工具主版本迁移；本轮按主任务边界保留原工具，不强制 overrides Tinypool 2.x。
- 成本/风险：中；全部单测、mock、快照与并行隔离都要复验。修复收益主要在开发机/CI 执行边界。

### 2. Electron-builder → sprintf：8 moderate

- 完整条目：`@electron/get`、`app-builder-lib`、`dmg-builder`、`electron-builder`、`electron-builder-squirrel-windows`、`global-agent`、`roarr`、`sprintf-js`。均为同一日志格式化链的传播评级，不能当 8 个独立漏洞。
- 实際路径：`desktop:pack/dist` → electron-builder 26.15.3 → app-builder-lib → @electron/get **3.1.0** → global-agent **3.0.0** → roarr **2.15.4** → sprintf-js **1.1.3**。
- 条件：攻击者控制 sprintf 的格式字符串并注入超限 precision，造成未捕获 RangeError、让调用中止。当前业务没有直接调用 sprintf；抽查 global-agent 日志将外部数据放 context、格式为字面量；未复现外部格式字符串可达路径。不能据此把公告删除。[公告](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
- **sprintf-js 官方尚无 patched version**，npm latest 仍 1.1.3，因此没有安全的同主补丁可装。
- 当前 app-builder-lib 要求 @electron/get ^3.0.0。官方 registry 的 getter 3.x 最大为 3.1.0、4.x 最大为 4.0.3，仍在 audit 影响链范围；当前 latest **@electron/get 5.1.0** 已不依赖 global-agent，采用它需要上游兼容版本/工具链升级，不能偷偷覆盖现有 3.x 范围。
- npm audit 对 builder 自动给出 **26.5.0** 并标记 isSemVerMajor=true；它实际比当前 **26.15.3 更早**，不是安全补丁升级。本轮不降级固定的打包器，也不 force 改历史依赖。
- 后续轮次：核对能正式移除该链的 builder release，独立测试 source 打包、native SQLite/sharp、arm64/x64、安装/退出/重启、既有数据接入和 rollback。具体 builder 兼容版本尚未确定，不猜测。
- 成本/风险：中到高；影响签名/打包/原生绑定，优先独立轮次，避免和当前行为修复混做。

## 本专项实际验证

- `npx vitest run tests/workbench.test.ts tests/blender-mcp.test.ts tests/preview-optimize.test.ts tests/source-open.test.ts tests/desktop.test.ts tests/contracts.test.ts tests/project-library.test.ts`：**7 个文件 41/41 通过，1.12 秒**。包括 MCP 19 项结果/marker/error 协议、原生预览优化、项目/附件/源文件/desktop contract；这些不是实际安装桌面或真实 AI 验收。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 额外 native 检查：从合成 PNG 实際编码并全解码 PNG/JPEG/WebP，尺寸/数据有效；坏图输入被拒绝。SQLite `:memory:` 创建/插入/查询成功，全程没有生产数据。
- `npm ls`：无错误，确认 direct、transitive 与固定工具版本。package/lock/root lock version 均为 本轮的 **1.1.1**；scripts/devFields 与 mutation 前快照一致。
- 前端 P1.3/P2.3/键盘新专项 19/19 + API 11/11 已单独交付，完整前端、构建、桌面包与无 AI Blender 回归的最终状态见 [工程记录](STABILITY.md)。本文件只记录依赖补丁专项，不代替发行验收。

