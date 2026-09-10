# 分支与发布说明

整理基准：2026-09-10，1.1 发布周期。

## 稳定主线

`main` 是当前稳定代码与 GitHub 首页的来源。每次发行使用版本标签（本次 `v1.1.0`），安装包放在 Releases。正式变更使用独立 `codex/*` 分支，经检查后合并。

PR #1、#2、#7、#8、#9、#10 已合并；对应远端功能分支可在确认提交均被主线包含后删除，提交仍由主线和 PR 记录保留。1.1 新增作品首页、文件入口与源文件打开，并保留已有桌面、图库、用量及录制导航改动。

## 已由后续版本接替的实现

PR [#3](https://github.com/damingishere-coder/Ai-FormaDesk/pull/3) 的聊天进度和视频方案早于桌面版。其原提交未整体合入主线；相应功能已由后续桌面、统一导出和录制导航实现接替。完成 1.1 回归后关闭旧 PR，保留 `codex/chat-progress-video-v3` 供历史对照，避免覆盖更新的实现。

## 继续保留的实验

| 分支 / 草稿 PR | 状态 |
| --- | --- |
| `codex/image3d-local` / [#4](https://github.com/damingishere-coder/Ai-FormaDesk/pull/4) | 四视角照片建模实验；十张样本未通过最终质量验收 |
| `codex/photo-fit-v2` / [#5](https://github.com/damingishere-coder/Ai-FormaDesk/pull/5) | 基于 #4 的照片约束实验；仍有未通过门槛 |
| `codex/stylized-v21` / [#6](https://github.com/damingishere-coder/Ai-FormaDesk/pull/6) | 基于 #5 的风格化阶段 A；未完成整体质量验收 |

这些分支保持 Draft，保留已有代码和证据，不纳入 1.1 稳定版，也不把文件生成成功视为照片还原通过。

## 本地工作区

旧主工作区含未提交开发内容，不能直接用远端覆盖。1.1 在独立发布工作树整合与验证；原修改保持可追溯。清理仅针对已合并且没有活动工作树的分支，仍在使用的工作树与未合并实验保留。
