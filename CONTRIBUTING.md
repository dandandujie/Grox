# 贡献指南

[English](CONTRIBUTING.en.md)

## 本地开发

准备 Go 1.27.3+、Node.js 22.6+ 和系统 WebView，再执行：

```sh
npm ci
npm run dev
npm run verify
```

npm 脚本通过 `scripts/with-go.mjs` 选择 Go 工具链。修改 Go 绑定或事件结构后运行 `npm run generate`，提交生成的 `src/mygo.ts`。更新网页预览测试数据时运行：

```sh
node scripts/with-go.mjs go run ./cmd/fixture > src/mock/bootstrap.json
```

## 提交前

- 界面功能应支持简体中文和英文。React 界面把文案交给 `useT`，在 `src/i18n/zh.json` 提供简体中文。保留机器可读的 ID、命令、文件路径及用户数据。
- 用户文档写在默认的中文页面，英文版本放在对应的 `.en.md` 中，两个入口互相链接。
- 密钥由 Go 后端保管。页面只接收是否已配置等状态。
- 验证正常入口及错误状态。修改界面时，检查键盘操作、焦点和窗口中实际呈现的结果。
