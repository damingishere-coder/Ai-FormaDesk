# Ai-FormaDesk · 造物工作台

在桌面工作台里描述一个想法，由 **本机 Codex App Server + Blender** 创建真正的三维场景。使用鼠标或属性面板调整，自动保存版本，继续对话，渲染和导出。

## 启动

正式使用请安装 [macOS 桌面应用](DESKTOP.md)。前端显示在应用独立窗口内。以下是完整功能与本地开发说明。

## 使用

1. 点击底部输入框，聊天记录向上展开。可以写想法，也可以通过“添加图片”、拖入或粘贴截图提供参考。支持 PNG/JPEG/WebP，每条最多 6 张、单张 10 MB、合计 40 MB。
2. 单独发图或讨论想法时先与 Codex 讨论。带参考图且明确要求建模时，会自动生成正面、右侧、顶部三视图，随后继续建模、制作材质与验证导出。顶部“参考与三视图”可查看和放大中间图片；失败候选也保留。文字方案仍可点击“开始建模／应用修改”执行。
3. 编辑模式下，拖动鼠标观察、滚轮缩放；点击对象或左下角场景列表选择。`W / E / R` 切换移动、旋转、缩放，`F` 适应模型。输入框内这些按键正常输入。
4. 拖动变换控件，松开时保存；属性面板点击“应用并保存”。继续讨论时 AI 使用最新保存的场景和对象 ID。撤销、重做和版本恢复保持可用。
5. 点击“导出”进入统一导出页面，在右侧切换“图片 / 模型 / 视频”。图片与视频分别保留尺寸设置，切换类型保留取景角度。图片支持横版、方形、竖版、自定义尺寸和透明背景；预览画面边界就是输出范围，生成后查看或下载 Blender PNG。PNG 单边 256～4096 像素，默认 1280×720、不透明；实时预览用于确认构图，最终材质和光照以成品图为准。
6. “模型”选择 `.blend` 或 `.glb` 后直接下载完整已保存场景，预览视角不会裁切模型。“视频”在同一页面调整尺寸、进入录制，支持实时视频和 Blender 精细渲染；录制时保持画框不变，完成后在本页保存、继续渲染或下载。录制过程中先结束录制再切换导出类型。
7. 应用先显示作品首页，可搜索、收藏、排序和查看文件。点击卡片“打开”进入工作台，点击顶部作品名称返回首页；卡片菜单可以重命名或移入回收站。回收站可恢复，彻底删除需要再次确认，活动任务完成或停止后才能删除。

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

AI 脚本在第一个 Blender 进程执行；第二个全新 Blender 进程禁用自动脚本并重新打开场景、校验和导出。文件结构、GLB、对象 ID 和场景清单全部通过后，才登记成功版本。Python 错误直接显示并保留脚本，由用户主动重试，不自动要求 AI 修复或重建。

网页采用 Blender Z-up ↔ glTF/Three.js Y-up 转换。观察变化不保存；对象变换保存到 Blender 局部坐标。程序化和图片材质保留在可编辑 `.blend`，GLB 使用烘焙贴图；网页调色保留贴图连接。图片流程的场景包含共享环境/曝光与面光源配置，网页与 Blender 仍允许渲染差异。复杂节点编辑不在 V1 范围内。PNG 按设置的比例输出，画布取景框与输出保持一致；每张图片保存提交时的相机、场景版本及输出设置。

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

实现按 [DEVELOPMENT.md](../DEVELOPMENT.md) 及已确认的第二版概念图开发。

- [官方 Codex App Server 协议](https://learn.chatgpt.com/docs/app-server)
- [Blender 4.5 LTS 官方下载](https://download.blender.org/release/Blender4.5/)
- [blender-mcp](https://github.com/ahujasid/blender-mcp)：通过固定版本的本机服务和 Blender 插件接入；[Blender-AI-Agent](https://github.com/ahmedsayed1911/Blender-AI-Agent)：架构参考。

当前版本面向单物体和小场景，支持视频交付；不提供完整网格拓扑编辑、雕刻、外部模型导入或多人协作。发布流程见开发指南。

验收结果、真实版本 ID 和边界见 [V1 验收记录](ACCEPTANCE.md)。

多模态、作品库和新预览的验收方法见 [V2 验收记录](V2-ACCEPTANCE.md)。

图片三视图流程、失败重试与验证边界见 [说明](THREEVIEW-PIPELINE.md)。

## Blender 联动与单轮建模

图片建模只生成一轮三视图，不再做 AI 视觉评分或自动返工。Blender CLI 继续负责批量建模和导出；新增 MCP 联动可打开源文件、调整部件并同步回网页。安装与使用见 [Blender MCP 接入说明](BLENDER-MCP.md)。
