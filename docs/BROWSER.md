# 受控浏览器

[English](BROWSER.en.md)

助理选择「本机」时，可以在任务运行期间操作独立的 Chrome 或 Chromium。Grox 按需创建临时浏览器配置，并在本轮结束后清理。电脑应安装可被桌面进程找到的 Chrome 或 Chromium。

| 工具 | 用途 |
| --- | --- |
| `browser_open` | 打开公开的 HTTP/HTTPS 地址，返回可见内容与控件引用。 |
| `browser_read` | 读取当前页面并更新控件引用。 |
| `browser_click`、`browser_type` | 操作上次读取获得的控件。输入支持普通文本框。 |
| `browser_back` | 返回上一页。 |
| `browser_screenshot` | 截取可见区域并附加到会话。支持视觉的模型可以在工具循环中读取图像。 |

「每次询问」审批所有浏览器操作。「自动」模式可读取当前页面，导航、交互和截图仍需审批。「完全授权」允许这些操作。每种模式都遵循助理的工具拒绝规则。Grox 会核对页面、控件和目标地址，控件引用在重新读取或操作后失效。

代理仅访问公开网络，拒绝本机、私网和链路本地地址。受控浏览器使用一个顶层页面，密码框、文件框、下载、弹窗、个人浏览器资料和 SSH 浏览器超出当前范围。

```sh
GROX_TEST_BROWSER=1 node scripts/with-go.mjs go test ./internal/browser -run '^TestManagedBrowserWorkflow$' -count=1
```
