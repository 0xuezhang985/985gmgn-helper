# 隐私说明

better gmgn 只在用户访问 `gmgn.ai`、`debot.ai`、`fomo.family` 与 `985monitor.xyz` 时注入固定的本地扩展代码，用于页面增强、登录态镜像和配置同步；扩展不包含远程执行代码。

## 本地保存的数据

- 重点 Dev、特别关注、备注、功能开关、颜色、黑名单、标注人物、持仓提醒清单和最近 100 条推送历史保存在浏览器本地 `chrome.storage.local`。历史只包含提醒类型、代币简称、触发值、时间和 GMGN 站内代币路径，不包含钱包地址或账号标识。
- FOMO 页面使用 Privy 登录。扩展会把页面已有的 access token 与 refresh token 镜像到扩展本地存储；令牌只用于请求 `fomo.family` 自己的 API。续期由一个真实 FOMO 页面中的 Privy SDK 完成，扩展不把令牌发给 985monitor 或其他第三方。
- GMGN 的钱包类接口和 App 通知配置接口需要站点自己的 Bearer。扩展只在 `gmgn.ai` 页面内读取 `localStorage.tgInfo`，只把该令牌发回 `gmgn.ai`；通知配置只读取 `holding_signal` 的逐链开关，令牌和账号标识均不写入扩展存储。
- 985monitor 的 FOMO/Pump 屏蔽名单、事件偏好、关注钱包和金额/代币过滤会从该站点账号同步到扩展本地，用于 GMGN 与 DeBot 追踪页过滤。网页钱包主令牌只随同源绑定请求发回 985monitor，不写入扩展；服务器另行签发用途受限的随机只读会话，原始会话保存在扩展本地，服务器仅保存 SHA-256 哈希。FOMO/Pump 页面本地偏好会按登录账号保存到 985monitor，以便关闭网页后继续同步。
- 扩展不读取钱包私钥、助记词、密码或 API Key。

## 网络访问

- `https://gmgn.ai/*`：读取页面数据、行情、持仓、同一账户的 App 持仓价格提醒开关，以及用户明确触发的钱包关注操作。
- `https://debot.ai/*`：仅在 DeBot 追踪页插入 FOMO/Pump 事件，并在 DeBot 代币页显示 FOMO 小窗与 RWA 资料浮窗。扩展读取已渲染追踪行的链、代币、钱包、买卖方向、金额、时间和交易哈希用于排序与去重，同源读取 DeBot 已公开展示的代币详情总供应量用于计算 FOMO 持仓占比，并读取 DeBot 原生池表中的代币地址与 985monitor 公开 RWA 目录在浏览器内匹配；不读取或保存 DeBot 登录凭据，不新建 DeBot WebSocket，也不执行交易。
- `https://prod-api.fomo.family/*`、`https://fomo.family/*`：读取 FOMO 数据并保活一个由站点 Privy SDK 自行续期的真实页面；扩展不直接请求 Privy sessions 接口。
- `https://985monitor.xyz/*`：在用户已登录时签发 FOMO/Pump 专用只读会话，并读取服务端按该账号关注、屏蔽、事件类型、金额和代币过滤后的配置与事件流。账号会话失效时插件停止读取，不回退到公共全量 FOMO/Pump 源。默认标注人物持仓产物仍按公开静态文件读取；用户自己添加的标注人物不会自动上报服务器，而是在浏览器内直查 GMGN。
- 用户填写自定义 BSC RPC 时，扩展会在确认后申请该 HTTPS 域名权限，并只发送公开链上只读调用。
- `https://api.github.com/repos/0xuezhang985/985gmgn-helper/releases/latest`：读取最新版本。
- `https://github.com/0xuezhang985/985gmgn-helper/releases/download/`：下载安装包和 SHA256 文件。

本地更新器不常驻后台，只在插件检查或安装更新时启动；下载的 ZIP 必须通过 SHA256、文件白名单、manifest 名称、版本和固定扩展 ID 校验。

## 联系方式

问题与安全报告请通过 GitHub Issues 提交：
https://github.com/0xuezhang985/985gmgn-helper/issues
