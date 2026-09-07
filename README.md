# Ai-FormaDesk · 造物工作台

在本机浏览器里描述一个想法，由 **本机 Codex App Server + Blender** 创建真正的三维场景。使用鼠标或属性面板调整，自动保存版本，继续对话，渲染和导出。

## 启动

本机可直接点击程序坞的 **Ai-FormaDesk** 绿色立方体图标。应用安装在 `~/Applications/Ai-FormaDesk.app`，调用本项目的启动脚本；项目文件夹需要保留在原位置。服务已运行时会直接打开网页。应用启动后退出属于正常现象，服务由终端窗口保持运行。

如需重建图标或项目移动后更新入口，在项目目录执行 `/usr/bin/python3 scripts/install-mac-app.py`。安装器使用 macOS 自带的 AppleScript、Swift/AppKit 和 iconutil，需要本机 Xcode 命令行工具；保留其他程序坞图标，旧入口与程序坞配置备份到 `data/launcher-backups`。

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

1. 点击底部输入框，聊天记录向上展开。可以写想法，也可以通过“添加图片”、拖入或粘贴截图提供参考。支持 PNG/JPEG/WebP，每条最多 6 张、单张 10 MB、合计 40 MB。
2. 发送消息只与 Codex 讨论。需求明确后出现方案卡；点击“开始建模／应用修改”才执行。可以继续聊天修改方案，旧方案会标记过期。
3. 编辑模式下，拖动鼠标观察、滚轮缩放；点击对象或左下角场景列表选择。`W / E / R` 切换移动、旋转、缩放，`F` 适应模型。输入框内这些按键正常输入。
4. 拖动变换控件，松开时保存；属性面板点击“应用并保存”。继续讨论时 AI 使用最新保存的场景和对象 ID。撤销、重做和版本恢复保持可用。
5. “预览”可自由旋转、平移、缩放。点击“渲染出图”设置比例、尺寸和透明背景，按画布取景框生成 Blender PNG。成品图单独查看，关闭后回到原三维视角。
6. “导出”提供 `.blend`、`.glb` 和 PNG。PNG 单边 256～4096 像素，默认 1280×720、不透明；场景、视角或设置变化后提示重新渲染，旧图仍可下载并查看原参数。
7. 点击顶部作品名称打开作品库。点击卡片只做临时三维预览，“打开编辑”才切换项目；卡片菜单可以重命名或移入回收站。回收站可恢复，彻底删除需要再次确认，活动任务完成或停止后才能删除。

默认是大画布、底部悬浮对话框、左侧工具条。对象属性、场景列表和历史按需出现，没有固定三栏。

## 数据与一致性

- `data/index.sqlite`：项目、版本、任务、产物和对话索引。
- `data/revisions/<id>/`：不可变版本文件。任务成功才更新当前版本指针。
- `data/jobs/<id>/attempt-*/`：本次脚本、命令、输入副本与执行日志；失败和取消也保留诊断。
- `data/codex-workspaces/<projectId>/`：项目专属 Codex 工作目录。会话 ID 关联项目，复用本机登录。
- `data/attachments/<projectId>/`：已校验的参考图片；已发送图片随作品保留，未发送图片超 24 小时回收。
- `data/discussion-workspaces/<projectId>/`：独立的只读创作讨论会话。
- `data/settings.json`：可选本地设置，例如 `{"modelingSeconds":120,"renderingSeconds":180}`。

备份时先停止工作台，然后复制整个 `data` 目录。运行数据、模型、日志和缓存被 Git 忽略。暂不提供自动清理历史，磁盘占用会随版本增长。

每次提交携带 `baseRevisionId`。后台拒绝旧版本写入并限制每项目只有一个活动任务；整个应用的 Blender 执行并发为 1。网页 GLB 的稳定 ID 来自 `.blend` 自定义属性 `forma_id`，不依赖名称。

AI 脚本在第一个 Blender 进程执行；第二个全新 Blender 进程禁用自动脚本并重新打开场景、校验和导出。文件结构、GLB、对象 ID 和场景清单全部通过后，才登记成功版本。Python 错误最多回传 AI 修复两次；每次从原版本副本重试。

网页采用 Blender Z-up ↔ glTF/Three.js Y-up 转换。观察变化不保存；对象变换保存到 Blender 局部坐标。网页 PBR 和光照为实时近似，程序化材质的完整节点保留在 `.blend`；GLB 使用其基础 PBR 回退值。手动修改颜色会断开该颜色的程序化输入，确保渲染也采用新颜色。复杂节点编辑不在 V1 范围内。PNG 按设置的比例输出，画布取景框与输出保持一致；每张图片保存提交时的相机、场景版本及输出设置。

## 本机安全边界

服务只监听 `127.0.0.1`，验证 Host、Origin、HttpOnly 本地会话和写操作校验令牌。产物接口只接受已登记的 ID。浏览器不能执行 Python 或调用 Codex 控制接口。

Blender 不继承认证环境变量；使用 macOS Seatbelt 沙箱，生成脚本只可写自己的任务目录，不能读取其他项目版本或联网。系统库、Blender 安装资源、可信工作程序为只读。macOS 26 动态加载器需要对 `/` 本身进行目录读取以解析系统库，这条规则不允许读取根目录下的文件内容。

受信任的 PNG 渲染额外允许 Blender 专属的 `com.apple.metalfe`、`com.apple.metal`、`com.apple.gpuarchiver` 缓存，以及向系统 Metal 编译服务授予这些缓存和 Blender 安装资源的限定访问。AI Python 执行不获得这些缓存授权。启动时分别验证建模与渲染沙箱的越界读取、写入、本机网络和外网连接限制；任意检查失败则停用执行，不自动降级为无沙箱。

Codex 工作台子进程禁用 shell、外部 MCP、应用、插件和多代理工具，拒绝审批请求，讨论接收结构化回复与方案，建模接收结构化脚本；二者都可以接收经过校验的真实参考图片。全局认证、提供商及模型配置不变；模型固定为 `gpt-6-astra`、思考档位「高」`high`。版本更换需要重新生成协议并验证兼容，不自动升级 CLI。

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

多模态、作品库和新预览的验收方法见 [V2 验收记录](docs/V2-ACCEPTANCE.md)。
