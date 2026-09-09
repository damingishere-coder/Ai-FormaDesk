# 1.0 桌面发布验收

日期：2026-09-09。实际平台：Apple Silicon Mac、macOS 26.6.2。应用最低系统要求为 macOS 13，其他系统版本尚未在本轮实机验收。Electron 44.3.0、内置 Node.js 22.23.2、Blender 4.5 LTS。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 15 个文件、56 项测试通过 |
| `npm run build` | TypeScript 与 Vite 构建通过 |
| `npm audit --omit=dev` | 生产依赖已知漏洞 0 |
| 界面回归 | 聊天、封面两种场景、统一导出、场景列表、撤销重做，共 6 项通过 |
| 独立 `.app` 启动 | 复制到源码目录之外，以最小 PATH 启动；验证 `app.isPackaged === true`，加载应用内置依赖、后台和前端 |
| 真实 GLB 显示 | 12 个可编辑对象的 Blender 测试作品正常显示 |
| 桌面隔离 | Node integration 关闭，context isolation / sandbox 开启 |
| 桌面会话 | 普通 HTTP 客户端直接请求桌面会话得到 403 |
| Blender 环境 | 建模与渲染沙箱检查通过 |
| 模型导出 | GLB 与 Blender 源文件下载完成，文件头验证通过 |
| 图片导出 | 真实 Blender 512×512 PNG 渲染与下载通过 |
| 灯光保留 | Blender 实例验证旧场景 World、已连接环境节点、灯光与色彩管理不被导出准备覆盖；真实既有作品副本前后渲染对照通过 |
| 网格与封面 | 建模视口和只读封面显示网格；旧封面重新生成，原封面文件与模型保留；导出画面不叠加辅助网格 |
| 实时视频 | 640×360 短录制、回放尺寸、保存到作品与下载通过 |
| 退出与重启 | 后台进程与数据锁释放，重启后作品恢复 |

桌面测试通过 `scripts/verify-desktop.mjs` 在独立 `desktop-smoke-*` 数据目录运行，未操作用户已有作品。测试作品由 `scripts/desktop-fixture.ts` 使用真实 Blender 创建；首页截图来自实际应用界面。自动下载验收由测试为 Electron DownloadItem 指定保存位置。

完整桌面导出验收：

```sh
FORMA_DESKTOP_EXECUTABLE="$PWD/release/mac-arm64/Ai-FormaDesk.app/Contents/MacOS/Ai-FormaDesk" \
FORMA_DESKTOP_MINIMAL_PATH=1 FORMA_DESKTOP_FULL=1 npm run test:desktop
```

灯光保留回归（使用临时 Blender 场景，不保存用户文件）：

```sh
"/Applications/Blender 4.5 LTS.app/Contents/MacOS/Blender" \
  --background --factory-startup --disable-autoexec --python scripts/verify-render-lighting.py
```

## 边界

- 本轮验证的是桌面封装与当前工作台回归，没有重新做所有图片类别的 AI 建模效果验收；三视图不是照片精确重建保证。
- 交互预览与 Blender 渲染使用不同渲染器，旧作品预览可能有额外补光；正式导出以保存的 Blender 场景灯光和材质为准。
- 实时视频验证为短录制，未把目标 60 fps 当作持续实测值。精细视频功能沿用当前工作台，未在本次桌面回归中重新做长视频验收。
- 本地 ad-hoc 签名用于应用完整性；不等于 Apple Developer ID 签名、公证或 App Store 分发。
- macOS 13 的最低要求来自 [Electron 44 发布说明](https://www.electronjs.org/blog/electron-44-0)，本轮实机系统为 macOS 26.6.2。
- 构建仍提示约 1.6 MB 的前端主包；该提示不阻止本次构建和运行。
