# 图片三视图、材质与灯光

上传参考图并明确说“根据这张图片建模……”后，工作台会自动开始图片流程。单独发图或讨论想法仍先讨论；多个可能主体时会询问对象。

顶部 **参考与三视图** 可以查看原图、三视图参考和材质贴图。旧任务的检查图与 AI 检查报告保留为历史，新流程不生成评分报告。默认只展示原图和三视图，点击缩略图放大。失败候选也保留。保存作品后参考资源复制到版本目录，重新打开、撤销和恢复不会丢失查看入口。

## 单轮流程（版本 2）

1. 保持现有 OpenAI 登录、`gpt-6-astra`、`high`。识别主体后生成一组三视图。
2. 正面先生成，另外两个视角共用原图、主体约束与正面图，最多并发两张。明确指定背面时使用正/右/背，否则使用正/右/顶；纹理投影始终使用模型自身的正/右/顶相机数据，和参考图视角分开。
3. 不调用三视图、形状、材质或灯光的 AI 视觉评分，不因评价结果自动重画或重建。三视图完成后直接写脚本并执行。
4. 一次材质规划与应用：纯色/PBR、程序化木纹/布纹、必要时生成投影纹理。只有纹理投影需要时才渲染模型视图；去掉仅用于自动评分的渲染。
5. 保留脚本退出码、PNG 完整解码、GLB/BLEND 有效性、稳定对象 ID、已有无关对象保护和版本冲突校验。运行校验不代表照片还原质量。
6. 各视角、脚本、执行与导出用时随任务记录。任务内复用视觉进程连接（最多两个图片槽位和一个 JSON 槽位），任务结束释放进程。

## 中断和重试

失败/取消不自动重试，用户主动重试复用同一输入下已完成的图片、脚本与阶段。并发图片全部退出后才结束任务，避免晚到结果写入已结束任务。每个视觉请求最多 10 分钟；取消/超时终止本任务进程。

旧检查报告保留为历史资料，不再阻止继续；恢复旧任务时优先复用最近完整的一组三视图。输入或基准场景变化时拒绝复用。

完成后保存可编辑模型，是否像原图由用户查看预览判断。隐藏结构仍属于推测。

## 文件组织

- `data/jobs/<runId>/visual/pipeline.json`：可恢复检查点、阶段、原图指纹、修正意见和产物关联。
- 同目录中的 `original-*.png`、`references-*`、`shape-*`、`appearance-*`：原图、参考图、候选模型、贴图、真实渲染和检查记录。
- `data/revisions/<revisionId>/references`：该保存版本自有的参考图和检查证据；`textures`：便携贴图。
- 失败产物保留在任务目录，不能覆盖当前作品。数据只随作品彻底删除而清理。

## 验证入口

```sh
npm test
npm run build
npx tsx scripts/verify-visual-cli.ts
npx tsx scripts/verify-visual-transport.ts
npx tsx scripts/verify-visual-blender.ts
npx tsx scripts/verify-visual-preservation.ts
npx tsx scripts/verify-threeview-live.ts
npx tsx scripts/compare-threeview.ts
```

前两个是本地测试和构建；CLI/live/compare 会真实使用当前 Codex 登录额度。所有验证脚本的产物放在自己的 `data/*-proof` 或 `data/threeview-live` 目录，不把样例自动写进用户项目。浏览器 `tests/browser/visual.spec.ts` 检查画廊、放大、重开及真实烘焙 GLB 的网页加载；API 在该 UI 测试中为受控数据，不代表完整服务验收。

五类实时样例为可重复的**合成参考图**：纯色方块、木桌、带色带圆柱、金属球、环形曲面。其结果只验证这些样例，不代表任意真实照片的还原质量。AI QA、文件/渲染证据、人工观察分别记录；没有用户人工验收时不可声称“照片忠实还原”。与单图直接脚本法的对照也可能没有质量提升。

## 参考方法

- [MV-Adapter](https://github.com/huanngzh/MV-Adapter)：多视图一致性与几何约束纹理生成。本实现只使用约束和检查思路，没有它的多视图模型/注意力网络，也没有相同能力保证。
- [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)：几何与纹理分阶段、PBR 贴图组织；未集成其权重或推理库。
- [BlenderProc](https://github.com/DLR-RM/BlenderProc)：自动材质配置、灯光布置和可信渲染检查；实际执行使用本仓库 Blender Python。
