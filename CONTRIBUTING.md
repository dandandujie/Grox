# 参与 Grox

欢迎通过 Issue 和 Pull Request 改进 Grox。提交前请确认：

- 桌面应用改动位于 `apps/desktop`。Grox 只适配 x.ai 官方发布的 Grok Build CLI，不接收内置或分叉运行时。
- 不提交 API 密钥、OAuth 凭据、签名证书、本地配置、构建产物或仅供开发过程使用的文档。
- 界面改动至少通过 `pnpm build`；Tauri 改动同时通过 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- 说明改动动机、验证方法，以及 Windows/macOS 中可能存在的平台差异。

涉及安全问题时不要公开披露，请遵循 [SECURITY.md](SECURITY.md)。
