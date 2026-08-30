# 隐私说明

better gmgn 只在用户访问 `gmgn.ai`、`fomo.family` 与 `985monitor.xyz` 时注入固定的本地扩展代码，用于页面增强、登录态镜像和配置同步；扩展不包含远程执行代码。

## 本地保存的数据

- 重点 Dev、特别关注、备注、功能开关、颜色、黑名单、标注人物和持仓提醒清单保存在浏览器本地 `chrome.storage.local`。
- FOMO 页面使用 Privy 登录。扩展会把页面已有的 access token 与 refresh token 镜像到扩展本地存储；令牌只用于请求 `fomo.family` 自己的 API。续期由一个真实 FOMO 页面中的 Privy SDK 完成，扩展不把令牌发给 985monitor 或其他第三方。
- GMGN 的钱包类接口和 App 通知配置接口需要站点自己的 Bearer。扩展只在 `gmgn.ai` 页面内读取 `localStorage.tgInfo`，只把该令牌发回 `gmgn.ai`；通知配置只读取 `holding_signal` 的逐链开关，令牌和账号标识均不写入扩展存储。
- 985monitor 的 FOMO 屏蔽名单、事件偏好和钱包地址会从该站点的本地存储同步到扩展本地，用于 GMGN 页面过滤；不会上传到扩展作者的服务器。
- 扩展不读取钱包私钥、助记词、密码或 API Key。

## 网络访问

- `https://gmgn.ai/*`：读取页面数据、行情、持仓、同一账户的 App 持仓价格提醒开关，以及用户明确触发的钱包关注操作。
- `https://prod-api.fomo.family/*`、`https://fomo.family/*`：读取 FOMO 数据并保活一个由站点 Privy SDK 自行续期的真实页面；扩展不直接请求 Privy sessions 接口。
- `https://985monitor.xyz/*`：读取公开的 FOMO 事件流和默认标注人物持仓产物。用户自己添加的标注人物不会自动上报服务器，而是在浏览器内直查 GMGN。
- 用户填写自定义 BSC RPC 时，扩展会在确认后申请该 HTTPS 域名权限，并只发送公开链上只读调用。
- `https://api.github.com/repos/0xuezhang985/985gmgn-helper/releases/latest`：读取最新版本。
- `https://github.com/0xuezhang985/985gmgn-helper/releases/download/`：下载安装包和 SHA256 文件。

本地更新器不常驻后台，只在插件检查或安装更新时启动；下载的 ZIP 必须通过 SHA256、文件白名单、manifest 名称、版本和固定扩展 ID 校验。

## 联系方式

问题与安全报告请通过 GitHub Issues 提交：
https://github.com/0xuezhang985/985gmgn-helper/issues
