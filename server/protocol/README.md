# 本机生成的官方协议类型

由 `codex-cli 0.153.4` 生成：

```sh
codex app-server generate-ts --out server/protocol
```

适配器使用 ThreadStartParams、TurnStartParams 等正式类型。协议来源：
https://learn.chatgpt.com/docs/app-server

本项目不自动升级 Codex。更换 CLI 版本时，先重新生成类型并运行环境检查与真实生成验收；未确认的版本不会自动视为兼容。

`npm run protocol` 调用官方生成器，并保留适配器实际使用类型的完整依赖闭包（本轮 21 个文件），避免提交未使用的数百个协议类型；生成文件内容未经手工修改。
