# Ai-FormaDesk · 造物工作台

在本机浏览器里描述一个想法，由 **本机 Codex App Server + Blender** 创建真正的三维场景。使用鼠标或属性面板调整，自动保存版本，继续对话，渲染和导出。

## 启动

本机已准备依赖时，双击 **`启动 Ai-FormaDesk.command`**。保留打开的终端窗口；按 `Control+C` 停止工作台。入口不会更新 Codex、修改登录或切换模型提供商。

访问 **http://127.0.0.1:8765**。

首次从仓库取出代码：

```sh
npm ci
npm run build
npm start
```

需要 Node.js 22+、已登录的 Codex CLI，以及 macOS Apple Silicon 版 Blender 4.5 LTS。本轮验证使用 Node 22.15.1、Codex CLI 0.153.4、Blender 4.5.13 LTS。Blender 独立安装在 `/Applications/Blender 4.5 LTS.app`，没有替换其他版本。

## 使用

1. 在底部输入“做一张木桌，桌上放一盏绿色台灯”，点击发送。阶段名称来自真实任务状态，没有模拟进度。
2. 拖动鼠标观察，滚轮缩放；点击对象或左下角场景列表选择。`W / E / R` 切换移动、旋转、缩放，`F` 适应模型。输入框中这些按键正常输入文字。
3. 拖动变换控件，松开时保存；属性面板编辑完点击“应用并保存”。保存时暂停进一步编辑。
4. 底部显示选中对象，继续发送修改要求；AI 使用已保存的最新 `.blend` 和对象 ID。
5. 顶部撤销、重做；左下角历史按钮可恢复任意旧版本。恢复后修改形成分支，旧文件保留。
6. 点击“渲染”，使用提交时的版本和观察方向输出 1280×720 EEVEE PNG。导出 `.blend`、`.glb`、当前版本 PNG；修改场景后旧 PNG 标记过期。

默认是大画布、底部悬浮对话框、左侧工具条。对象属性、场景列表和历史按需出现，没有固定三栏。

## 数据与一致性

- `data/index.sqlite`：项目、版本、任务、产物和对话索引。
- `data/revisions/<id>/`：不可变版本文件。任务成功才更新当前版本指针。
- `data/jobs/<id>/attempt-*/`：本次脚本、命令、输入副本与执行日志；失败和取消也保留诊断。
- `data/codex-workspaces/<projectId>/`：项目专属 Codex 工作目录。会话 ID 关联项目，复用本机登录。
- `data/settings.json`：可选本地设置，例如 `{"modelingSeconds":120,"renderingSeconds":180}`。

备份时先停止工作台，然后复制整个 `data` 目录。运行数据、模型、日志和缓存被 Git 忽略。暂不提供自动清理历史，磁盘占用会随版本增长。

每次提交携带 `baseRevisionId`。后台拒绝旧版本写入并限制每项目只有一个活动任务；整个应用的 Blender 执行并发为 1。网页 GLB 的稳定 ID 来自 `.blend` 自定义属性 `forma_id`，不依赖名称。

AI 脚本在第一个 Blender 进程执行；第二个全新 Blender 进程禁用自动脚本并重新打开场景、校验和导出。文件结构、GLB、对象 ID 和场景清单全部通过后，才登记成功版本。Python 错误最多回传 AI 修复两次；每次从原版本副本重试。

网页采用 Blender Z-up ↔ glTF/Three.js Y-up 转换。观察变化不保存；对象变换保存到 Blender 局部坐标。网页 PBR 和光照为实时近似，程序化材质的完整节点保留在 `.blend`；GLB 使用其基础 PBR 回退值。手动修改颜色会断开该颜色的程序化输入，确保渲染也采用新颜色。复杂节点编辑不在 V1 范围内。固定 PNG 比例为 16:9，保持提交相机的垂直视野、方向和目标，水平裁幅可能与浏览器比例不同。

## 本机安全边界

服务只监听 `127.0.0.1`，验证 Host、Origin、HttpOnly 本地会话和写操作校验令牌。产物接口只接受已登记的 ID。浏览器不能执行 Python 或调用 Codex 控制接口。

Blender 不继承认证环境变量；使用 macOS Seatbelt 沙箱，生成脚本只可写自己的任务目录，不能读取其他项目版本或联网。系统库、Blender 安装资源、可信工作程序为只读。macOS 26 动态加载器需要对 `/` 本身进行目录读取以解析系统库，这条规则不允许读取根目录下的文件内容。

受信任的 PNG 渲染额外允许 Blender 专属的 `com.apple.metalfe`、`com.apple.metal`、`com.apple.gpuarchiver` 缓存，以及向系统 Metal 编译服务授予这些缓存和 Blender 安装资源的限定访问。AI Python 执行不获得这些缓存授权。启动时分别验证建模与渲染沙箱的越界读取、写入、本机网络和外网连接限制；任意检查失败则停用执行，不自动降级为无沙箱。

Codex 工作台子进程禁用 shell、外部 MCP、应用、插件和多代理工具，拒绝审批请求，只接收结构化建模脚本。全局认证、提供商及模型配置不变；模型固定为 `gpt-6-astra`、思考档位「高」`high`。版本更换需要重新生成协议并验证兼容，不自动升级 CLI。

## 本地配置与开发

可在启动前设置：

| 变量 | 用途 |
| --- | --- |
| `ZAOWU_BLENDER` | Blender 可执行文件绝对路径，不是 `.app` 目录 |
| `ZAOWU_CODEX` | Codex CLI 可执行文件路径 |
| `ZAOWU_DATA_DIR` | 独立数据目录，默认项目内 `data` |
| `ZAOWU_PORT` | 本地端口，默认 `8765` |

```sh
npm run dev       # 后台热重载，8765
npm run dev:web   # Vite，5173，代理后台接口
npm run protocol  # 从当前 CLI 重新生成官方类型；不会升级 CLI
npm run check:environment
npm test
npm run test:integration
npm run test:e2e  # 会调用真实 Codex，消耗本机账户额度，并创建验收项目
npx tsx scripts/fault-checks.ts # 需要 data/acceptance/final-scene.json；独立数据测试
```

启动检查页在右下角设置按钮中。未登录时请自行在本机终端检查 `codex login status` 并完成原有登录。模型不可用、额度不足或凭据失效时，已保存模型仍可查看、手动编辑与导出。错误任务不会覆盖成功版本。

## 参考

实现按 [DEVELOPMENT.md](DEVELOPMENT.md) 及已确认的第二版概念图开发。

- [官方 Codex App Server 协议](https://learn.chatgpt.com/docs/app-server)
- [Blender 4.5 LTS 官方下载](https://download.blender.org/release/Blender4.5/)
- [blender-mcp](https://github.com/ahujasid/blender-mcp)、[Blender-AI-Agent](https://github.com/ahmedsayed1911/Blender-AI-Agent)：架构参考，未复制其业务实现。

本项目不自动部署，不自动合并 PR。V1 面向单物体和小场景；不包含网格拓扑编辑、雕刻、动画、导入外部模型或多人协作。

验收结果、真实版本 ID 和边界见 [V1 验收记录](docs/ACCEPTANCE.md)。
