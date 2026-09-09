# 1.0 桌面发布验收

日期：2026-09-09。实际平台：Apple Silicon Mac、macOS 26.6.2。应用最低系统要求为 macOS 13，其他系统版本尚未在本轮实机验收。Electron 44.3.0、内置 Node.js 22.23.2、Blender 4.5 LTS。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 15 个文件、56 项测试通过 |
| `npm run build` | TypeScript 与 Vite 构建通过 |
| `npm audit --omit=dev` | 生产依赖已知漏洞 0 |
| 界面回归 | 聊天、封面两种场景、统一导出、场景列表、撤销重做，共 6 项通过 |
| 独立 `.app` 启动 | 已验证 `app.isPackaged === true`，加载本机内置后台和前端 |
| 真实 GLB 显示 | 12 个可编辑对象的 Blender 测试作品正常显示 |
| 桌面隔离 | Node integration 关闭，context isolation / sandbox 开启 |
| 桌面会话 | 普通 HTTP 客户端直接请求桌面会话得到 403 |
| Blender 环境 | 建模与渲染沙箱检查通过 |
| 模型导出 | GLB 与 Blender 源文件下载完成，文件头验证通过 |
| 图片导出 | 真实 Blender 512×512 PNG 渲染与下载通过 |
| 实时视频 | 640×360 短录制、回放尺寸、保存到作品与下载通过 |
| 退出与重启 | 后台进程与数据锁释放，重启后作品恢复 |

桌面测试通过 `scripts/verify-desktop.mjs` 在独立 `desktop-smoke-*` 数据目录运行，未操作用户已有作品。测试作品由 `scripts/desktop-fixture.ts` 使用真实 Blender 创建；首页截图来自实际应用界面。自动下载验收由测试为 Electron DownloadItem 指定保存位置。

完整桌面导出验收：

```sh
FORMA_DESKTOP_EXECUTABLE="$PWD/release/mac-arm64/Ai-FormaDesk.app/Contents/MacOS/Ai-FormaDesk" \
FORMA_DESKTOP_FULL=1 npm run test:desktop
```

## 边界

- 本轮验证的是桌面封装与当前工作台回归，没有重新做所有图片类别的 AI 建模效果验收；三视图不是照片精确重建保证。
- 实时视频验证为短录制，未把目标 60 fps 当作持续实测值。精细视频功能沿用当前工作台，未在本次桌面回归中重新做长视频验收。
- 本地 ad-hoc 签名用于应用完整性；不等于 Apple Developer ID 签名、公证或 App Store 分发。
- macOS 13 的最低要求来自 [Electron 44 发布说明](https://www.electronjs.org/blog/electron-44-0)，本轮实机系统为 macOS 26.6.2。
- 构建仍提示约 1.6 MB 的前端主包；该提示不阻止本次构建和运行。
