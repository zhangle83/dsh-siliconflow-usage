# dsh-siliconflow-usage

DeepSeek Harness（DSH）Web UI 插件：在侧边栏显示当前 **SiliconFlow** 模型的实时单价与谷时倒计时，在输入框上方显示**本会话**的 token 用量与估算花费。

> V1 只做稳定功能。账户余额与代金券暂未实现：SiliconFlow 的 `/v1/user/info` 已停服（HTTP 410），控制台需要登录态且由客户端渲染，登录页也没有密码框，自动登录不可行。计划在 V1.5 用“粘贴控制台 Cookie”的实验方案补齐。

## 功能

**侧边栏底部卡片**
- 当前模型与密钥状态（绿=有效，红=无效，灰=未配置/未知）
- 当前时段单价：输入 / 输出 / 缓存（元 / 百万 tokens）
- 当前计费时段与**下一次真实变价**倒计时（北京时间，谷时 02:00–08:00）
- 价格来自 `www.siliconflow.cn/pricing` 实时抓取，缓存 6 小时；抓取失败时回退到内置快照并标注“价格快照”
- 点击刷新；侧栏收起时显示 `¥`

**输入框上方用量条**（仅当当前会话有 SiliconFlow 调用）
- `本会话 · 输入 … · 缓存 … · 输出 … · ≈ ¥… · N 次调用`
- 按**每条消息发生时刻的时段**逐条计价，跨 02:00 / 08:00 的会话自动分段
- 缓存 token 按缓存价计费；未收录价格的模型标为未定价
- 15 秒轮询，页面隐藏时暂停

当前路由不是 `siliconflow` 时，两个卡片自动隐藏。

## 安装

在 DSH Desktop / Web UI 的 **插件（Plugins）** 页选择安装组合包，把下面的 spec 粘贴进去：

```
github:zhangle83/dsh-siliconflow-usage
```

等价的 HTTPS Git 地址（两者都走 `git ls-remote` + `pnpm add`）：

```
https://github.com/zhangle83/dsh-siliconflow-usage.git
```

如果只想下载快照、不走 Git，可用 tarball：

```
https://github.com/zhangle83/dsh-siliconflow-usage/archive/refs/heads/main.tar.gz
```

安装后刷新页面。插件会写入当前 profile 的 `dsh.profile.bundles`，重启后仍然生效。

> 安装前 DSH 会对 GitHub 仓库做一次 5 秒的 `git ls-remote` 连通性检查；网络到 `github.com` 不通时这一步会报 `failedAt: 'spec-host'`，与包本身无关。

### 本地开发安装

```
plugin_manager install_bundle  <本仓库绝对路径>
```

## 配置

默认值即可用于标准 SiliconFlow 配置：

| 项 | 默认值 |
| --- | --- |
| provider id | `siliconflow` |
| baseURL | `https://api.siliconflow.cn/v1` |
| API Key 引用 | `SILICONFLOW_API_KEY`（通过 DSH credentials 解析） |
| 价格页 | `https://www.siliconflow.cn/pricing` |
| 价格缓存 | 6 小时 |

`baseURL` 可用环境变量 `SILICONFLOW_BASE_URL` 覆盖。

## 数据与安全

- Host 只注册两个本地只读 JSON 路由：
  - `GET /api/siliconflow-pricing`
  - `GET /api/siliconflow-usage?sessionId=…`
- API Key 只在 Host 进程内读取，用于探测 `/v1/models`，**不会下发给前端**。
- 用量来自会话日志中的 `assistant/message` 事件；不读取、不上传其他内容。

## 计价口径

```
billableInput = max(0, inputTokens - cacheReadTokens)
cost = (billableInput × 输入价 + cacheReadTokens × 缓存价 + outputTokens × 输出价) / 1_000_000
```

- 若模型没有缓存价，缓存按输入价计。
- 有输入长度分档的模型按第一档估算，卡片上以 `*` 标注。

## 验证状态

- 定价 / 用量两个路由实测返回 200；用量结果与原始会话日志独立重算完全一致。
- 客户端两个挂载点（`sidebar.footer.action`、`conversation.input.dock`）注册为 active。
- 像素级视觉效果未在无浏览器控制的环境下代看；不同 DSH 版本的侧栏布局可能有差异。

## 许可

MIT
