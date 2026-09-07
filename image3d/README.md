# 本地图生建模与局部精修

这里包含本地运行环境、独立验证工具及工作台图生建模路线。四视角纹理、候选保存及局部表面精修已接入；自动纠错和跨类别视觉验收仍在进行。
只有真实的形体生成、AI 纹理推理、StableGen 投射烘焙及网页查看全部通过，
才能进入完整工作台改造。单个探针通过不会把整条路线标记成功。

## 已固定的输入

- `runtime.lock.json`：Hunyuan3D-Swift、StableGen、ComfyUI、IPAdapter 节点源码提交；全部模型的仓库版本、字节数和 SHA-256。
- `swift-dependencies.lock.json`：MLX Swift、Swift Numerics 和 MLX/MLX-C 子模块提交。
- 形体使用 shape-small、30 步、octree 256、种子 42。
- 纹理使用 SDXL Base 1.0、FP16 Depth ControlNet、IPAdapter Plus ViT-H、Lightning 8 步。逐视角 512，最终图集 2048。单视角诊断探针的图集默认 512，可用 `--atlas 2048` 验证上限。
- `comfy-backend.requirements.txt` 记录依赖筛选来源；实际安装使用 `comfy-python.requirements.txt`，固定 75 个包及 SHA-256。`blender-python.requirements.txt` 单独固定 5 个 Blender 补充依赖。

模型权重共约 15.9 GiB，另需依赖、编译缓存及至少 10 GiB 工作余量。
运行目录与源码分离，默认位于 `data/image3d-runtime`，不会纳入 Git。

## 下载与编译

从项目根目录运行；`--runtime` 可以指定独立磁盘目录：

```sh
python3 scripts/image3d/setup.py --source hunyuan-swift --source stablegen --source comfyui --source ipadapter-plus
python3 scripts/image3d/setup.py --weights shape-small --workers 24
python3 scripts/image3d/setup.py --weights sdxl-base --weights depth-controlnet --weights ipadapter --weights clip-vision --weights lightning-8step --workers 24
python3 scripts/image3d/build.py --runtime data/image3d-runtime
python3 scripts/image3d/python_env.py --runtime data/image3d-runtime --engine comfy
python3 scripts/image3d/python_env.py --runtime data/image3d-runtime --engine blender
```

下载仅访问清单指定的官方来源；支持分片内部断点续传，检查响应字节范围后仍校验完整 SHA-256。
已有损坏文件会报错并保留；不会自动删除用户文件或回退到其他模型。
推理不会触发模型下载。
Python 环境安装需要 Python 3.12 / macOS arm64，Blender 补充依赖使用单独的 Python 3.11 兼容 wheel；不会修改 Blender 内置 Python。

Swift 编译器和 Metal 编译器是两项独立检查。单独的 `swift build`
不会构建 MLX 需要的 Metal 着色器；需要可运行的 Apple Metal Toolchain
及 Xcode 构建。运行时还需让 CLI 找到对应的着色器资源。
`repair_swift_cache.py` 仅修复一次实际遇到的 SwiftPM 6.3 缓存注册中断：
先验证所有检出提交及子模块，保留缓存备份，再补齐注册；不修改上游源码。

## 独立探针

每次使用新的任务目录，旧目录不会被覆盖：

```sh
python3 scripts/image3d/probe.py --runtime data/image3d-runtime --job data/probes/foreground-01 --case foreground --image /absolute/path/reference.png
python3 scripts/image3d/probe.py --runtime data/image3d-runtime --job data/probes/environment-01 --case environment
python3 scripts/image3d/health.py --runtime data/image3d-runtime --verify
python3 scripts/image3d/probe.py --runtime data/image3d-runtime --job data/probes/shape-01 --case shape --image /absolute/path/transparent.png
python3 scripts/image3d/probe.py --runtime data/image3d-runtime --job data/probes/full-01 --case full --image /absolute/path/transparent.png --atlas 2048 --memory-limit-gib 12
```

其他探针：`workflow` 生成真实 StableGen 工作流；`prepare --glb ...`
验证导入、尺度归一化、深度图、四面检查图和独立预览；`projection --blend ...` 验证投射、烘焙和导出。
`texture --glb ... --image ...` 复用已验证形体排查 AI 纹理，避免每次重新生成形体；它仍不替代一次完整 `full` 验证。
`fixture.py` 生成原创蓝色花瓶测试资产，不能作为照片重建效果验收。

`run.json` 记录阶段、退出码、实际参数、耗时和峰值常驻内存。
常驻内存数字不等于完整 GPU 内存或整机内存峰值。
新运行另外通过 macOS `proc_pid_rusage` 采样专属进程组内存占用；这仍不是单独的 GPU 内存计量。
`completePipeline` 在子探针中始终为 false；后台链路通过后，网页和视觉检查仍需单独记录。
四视角路线使用有限的轮廓搜索估计照片相机，保留正面原照，依次生成左右侧与背面；估计相机不等于真实相机参数。CLI 不默认运行 GPT，工作台通过 `--quality-handshake` 在上色前检查形体，最多换种子重生成一次；独立保留两个候选。

## 运行边界

- 推理使用 macOS 沙箱，产物只写当前任务目录；源码、权重只读。GPU 任务额外允许系统 Metal 编译服务使用其专属编译缓存。
- 默认禁止联网。纹理任务只允许专属本机 ComfyUI 端口，且关闭其 API 节点。
- 推理与工作台 runBlender 使用同一文件锁串行；已有渲染及经 runBlender 调用的视频执行会共享此锁。本分支不包含主工作区尚未提交的视频改动。
- 30 分钟预算从取得推理锁开始，包含各推理阶段；排队、安装和权重校验不计入。
- 针对当前 16 GiB Mac，进程组占用采样超过 11 GiB 时停止该阶段并保留候选；可用 `--memory-limit-gib 12` 复现已通过的单视角纹理试验。该保护不等于整机不会发生内存压力，实测存在交换内存活动。
- 取消及超时终止专属进程组；独立守护进程在主后台崩溃时终止孤立推理。失败只保留任务产物，不写入作品版本。
- 网页验证服务只公开输入图、导出的 GLB 和 Three.js 文件，不公开任务日志。

```sh
python3 -m unittest discover -s scripts/image3d -p 'test_*.py' -v
python3 scripts/image3d/viewer.py --job data/probes/full-01 --three node_modules/three
# 在另一终端验证实际载入与旋转；先核对服务返回的 GLB 与任务文件 SHA-256。
node scripts/image3d/browser_probe.mjs data/probes/full-01
python3 scripts/image3d/cancel_probe.py --runtime data/image3d-runtime --job data/probes/cancel-01 --image /absolute/path/transparent.png
```

## 来源与许可证

上游代码作为独立检出保留其许可证，适配器不复制上游业务代码。

| 组件 | 来源 / 许可证记录 |
| --- | --- |
| Hunyuan3D-Swift | [仓库](https://github.com/ZimengXiong/Hunyuan3D-Swift)，MIT；形体权重单独适用 Tencent Hunyuan Community 许可证 |
| StableGen | [仓库](https://github.com/sakalond/StableGen)，GPL-3.0 |
| ComfyUI | [仓库](https://github.com/Comfy-Org/ComfyUI)，GPL-3.0 |
| IPAdapter 节点 | [仓库](https://github.com/cubiq/ComfyUI_IPAdapter_plus)，GPL-3.0 |
| SDXL / Depth ControlNet / Lightning | 模型发布页标注 OpenRAIL++；具体发布版本见锁定清单 |
| IPAdapter 权重 | [模型发布页](https://huggingface.co/h94/IP-Adapter)，Apache-2.0 |

模型卡、独立许可证及安装证据保留在运行目录；本表不替代各组件许可证正文。

## 现有材质流程回归

`tests/blender/material_roundtrip.py` 使用真实 Blender 验证纹理改色、重复修改、法线与透明度连接、稳定 ID 和修改器统计。网页外观面板已增加独立“替换为纯色”操作，普通改色仍保留贴图。

```sh
"/Applications/Blender 4.5 LTS.app/Contents/MacOS/Blender" --background --factory-startup --disable-autoexec --threads 4 --python-exit-code 1 --python tests/blender/material_roundtrip.py -- "$PWD" "$PWD/data/probes/material-01"
```

## M2 顺序加载适配

`native/image3d/comfy_nodes` 仅供专属 ComfyUI 实例使用，依次执行参考编码、UNet/IPAdapter/深度推理和 CPU VAE 解码。运行采用分块注意力，MPS high/low watermark 为 1.0/0.65。固定 Lightning 权重仅包含 UNet LoRA；默认逐参数合并到当前任务独占的 UNet，避免完整备份权重；文本编码器使用 SDXL 原生倒数第二层。旧 bypass 节点仅保留作诊断对照，升级上游前必须重跑完整验证。

浏览器验证后执行 `python3 scripts/image3d/acceptance.py --job data/probes/full-01`，它核对完整阶段及当前 GLB 与浏览器记录的 SHA-256，产出技术兼容性记录；它不会把类别或照片还原质量自动判为通过。

## 工作台候选路线

可用 `FORMA_IMAGE3D_RUNTIME` 指定已安装的独立运行目录。环境检查分别展示形体、纹理与磁盘余量；运行前还会校验完整权重。上传或粘贴图片后点击“准备主体”，在蒙版画布确认主体后生成候选。旧方案缺少 `route` 时仍使用脚本路线。

图片准备返回不可变处理图 ID；修补蒙版和裁切产生新记录。推理候选与当前作品版本分离，形体可先预览；四视角上色后再次对照照片。未通过检查时返回 `partial`，保留原版本。通过文件验证的上色候选可由用户明确选择“保存为可编辑版本”，记录未通过的质量检查，不把采用候选当成类别验收。成功版本仍标记实验性。

真实集成检查入口：`scripts/image3d/workbench_probe.ts`、`resource_probe.ts` 和 `app_probe.mjs`；都需要单独的数据/证据目录。完整实测结果及未完成项见 `LOCAL-REPORT.md`。

## 局部表面精修

选中已保存的网格后，点击“精修表面”，在冻结的当前视角框选或涂选区域并输入要求。专属 ComfyUI 生成一张 512 纹理候选，随后按可见性把选区颜色写入已有 UV 图集。原 PNG 选区外像素和透明度保持不变；共享材质及图片会隔离，原网格、UV、ID 和对象变换保留。该步骤不重建形体。

首版支持单个无修改器网格、一个含单张 PNG 基础颜色图的材质、无重叠的标准 UV；不符合条件时明确报错并保留原版本。精修分辨率不超过 2048，修改效果仍需视觉检查。“调整形体”使用现有受限 Blender 脚本路线，并保留历史版本；不会扩大脚本权限。

实际检查入口：`refine_probe.py` 验证局部投射与几何不变（合成颜色，不代表 AI 推理）；`refine_browser_probe.mjs` 运行真实网页框选、本机推理、保存、导出和撤销/重做。`category_probe.mjs` 对固定公开样本运行真实 API 流程，结果始终不自动标记用户视觉通过。

四视角独立技术探针：

```sh
python3 scripts/image3d/pipeline.py --runtime data/image3d-runtime --job data/probes/multiview-01 --image /absolute/path/transparent.png --prompt "A wooden chair with a taupe fabric cushion"
```

`--shape /absolute/path/shape.glb` 只用于复用几何的纹理诊断，不作为完整图生技术验收。独立探针不要使用需要工作台响应的 `--quality-handshake`。
