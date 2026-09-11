# 隐私说明

better gmgn 只在用户访问 `gmgn.ai`、`debot.ai`、`fomo.family` 与 `985monitor.xyz` 时注入固定的本地扩展代码，用于页面增强、公开发行/底池展示、登录态镜像和配置同步；扩展不在 Brew 官网注入界面，也不包含远程执行代码。

## 本地保存的数据

- 相似币浮窗的保留结果只放在当前 GMGN 标签页内存，最多 400 项，包括代币名称、ticker、链、地址、公开市值和底池字段；不写入磁盘、不上传服务器。默认保留 5 分钟，可配置 1 / 5 / 10 / 30 分钟；关闭功能或刷新页面后清空。保留时长这一设置本身保存在 `chrome.storage.local`。
- 重点 Dev、特别关注、备注、功能开关、颜色、黑名单、标注人物、持仓提醒清单、Brew 公开行情缓存、Fomo 限流截止时间和最近 100 条推送历史保存在浏览器本地 `chrome.storage.local`。Fomo 限流状态只包含截止时间、退避等级和最近命中时间，不包含令牌或响应内容；Brew 缓存只包含公开的代币、官方池地址、公开市场数据与官方代币头像；提醒历史只包含提醒类型、代币简称、触发值、时间和 GMGN 站内代币路径，不包含钱包地址或账号标识。
- FOMO 页面使用 Privy 登录。扩展会把页面已有的 access token 与 refresh token 镜像到扩展本地存储；令牌只用于请求 `fomo.family` 自己的 API。续期由一个真实 FOMO 页面中的 Privy SDK 完成，扩展不把令牌发给 985monitor 或其他第三方。
- GMGN 的钱包类接口和 App 通知配置接口需要站点自己的 Bearer。扩展只在 `gmgn.ai` 页面内读取 `localStorage.tgInfo`，只把该令牌发回 `gmgn.ai`；通知配置只读取 `holding_signal` 的逐链开关，令牌和账号标识均不写入扩展存储。
- 「屏蔽同步 GMGN 黑名单」默认开启，仅在用户长按屏蔽或点击恢复时，通过当前页面已有的 GMGN 原生黑名单状态与保存机制，增删指定链的「合约地址」条目。不修改开发者、资金来源、关键词或其它类型，不批量迁移旧记录；原生名单满额时拒绝添加而不淘汰旧条目。插件本地仅记录代币链、地址、简称和是否曾同步，不读取或传出 GMGN 登录凭据，也不把黑名单发往 985monitor。用户可在设置中关闭同步。
- 985monitor 的 FOMO/Pump 屏蔽名单、事件偏好、关注钱包和金额/代币过滤会从该站点账号同步到扩展本地，用于 GMGN 与 DeBot 追踪页过滤。网页钱包主令牌只随同源绑定请求发回 985monitor，不写入扩展；服务器另行签发用途受限的随机只读会话，原始会话保存在扩展本地，服务器仅保存 SHA-256 哈希。FOMO/Pump 页面本地偏好会按登录账号保存到 985monitor，以便关闭网页后继续同步。
- 扩展不读取钱包私钥、助记词、密码或 API Key。

## 网络访问

- `https://gmgn.ai/*`：读取页面数据、行情、持仓、同一账户的 App 持仓价格提醒开关，以及用户明确触发的钱包关注操作。右侧「监控」打开时，全链聚合只在当前页面内复用 GMGN 自己的关注钱包快照接口和既有共享 WebSocket；不复制 GMGN 登录凭据、不新建 WebSocket、不把监控数据发给插件服务器。Brew 浮窗打开时，扩展后台还会把 Brew 官方代币地址按每批最多 10 个、最多 4 路并发提交给 GMGN 官方 `mutil_window_token_info`，只读取公开的池地址、价格、供应量、流动性、成交量、涨幅和 DEX 字段；首次及每 10 分钟读取全量，每 2 分钟只更新市值前 200 名与最新 100 个发行，失败后不会立即重复全量请求；不发送 985monitor 数据。
- `https://debot.ai/*`：仅在 DeBot 追踪页插入 FOMO/Pump 事件，并在 DeBot 代币页显示 FOMO 小窗与 RWA 资料浮窗。扩展读取已渲染追踪行的链、代币、钱包、买卖方向、金额、时间和交易哈希用于排序与去重，同源读取 DeBot 已公开展示的代币详情总供应量用于计算 FOMO 持仓占比，并读取 DeBot 原生池表中的代币地址与 985monitor 公开 RWA 目录在浏览器内匹配；不读取或保存 DeBot 登录凭据，不新建 DeBot WebSocket，也不执行交易。
- `https://prod-api.fomo.family/*`、`https://fomo.family/*`：读取 FOMO 持仓者、观点、交易与当前热门代币数据，并保活一个由站点 Privy SDK 自行续期的真实页面；扩展不直接请求 Privy sessions 接口。所有 Fomo 官方 API 请求全局串行且至少间隔 1.5 秒，同一代币同一标签合并并发请求；热门数据只在用户打开 GMGN 的 `fomo` 热门标签时读取并缓存 60 秒。收到 429 后插件在本地断路退避，冷却期不再请求官方接口。
- `https://www.stonkfun.xyz/*`：只读取公开的 `/api/quote-tokens` 目录，并只保留站点明确标记为 `xstock` 的 Solana mint、简称、名称与小数位，用于在 GMGN 的 Solana 底池中精确识别 RWA 配对资产；不向 StonkFun 发送 GMGN 登录态或用户配置。
- `https://brewfamily.app/*`：不在 Brew 官网注入内容，也不读取 Brew 钱包、登录态或交易数据。Brew 浮窗打开时，扩展后台优先通过用户本地网络读取公开 `/launch-checkpoint.json`；官网文件失效时自动使用随扩展发布的内置链上基线，不会把 404 显示成空面板。
- `https://rpc-bsc.48.club/*`、`https://bsc.rpc.blxrbdn.com/*`：在 Brew 增量同步中，按固定工厂与固定 `TokenLaunched` 事件读取基线之后的 BSC 区块日志，第二个节点仅在首选节点失败时退避使用；每段最多 5,000 个区块、每次刷新最多 8 段，扫描进度和公开发行记录只保存在浏览器本地。请求不包含账号、钱包、登录态或 985monitor 数据。
- `https://bsc-dataseed.bnbchain.org/*`、`https://rpc-bsc.48.club/*`、`https://bsc.rpc.blxrbdn.com/*` 等现有 BSC RPC：对 Flap 代币、税收处理器和官方 Lens 发起只读 `eth_call`，读取底池计价币、税率、分红资产及真实 vault 类型；同时对 Brew 官方快照声明的链上图片合约批量调用只读 `eth_getCode`，在浏览器本地验证 PNG/JPEG/WebP 文件头并生成头像。请求不发送账号、钱包、登录态或 985monitor 数据。
- `https://985monitor.xyz/*`：在用户已登录时签发 FOMO/Pump 专用只读会话，并读取服务端按该账号关注、屏蔽、事件类型、金额和代币过滤后的配置与事件流。账号会话失效时插件停止读取，不回退到公共全量 FOMO/Pump 源。默认标注人物持仓产物仍按公开静态文件读取；用户自己添加的标注人物不会自动上报服务器，而是在浏览器内直查 GMGN。Brew 战壕不使用 985monitor 接口或服务器资源。
- 用户填写自定义 BSC RPC 时，扩展会在确认后申请该 HTTPS 域名权限，并只发送公开链上只读调用。
- `https://api.github.com/repos/0xuezhang985/985gmgn-helper/releases/latest`：读取最新版本。
- `https://github.com/0xuezhang985/985gmgn-helper/releases/download/`：下载安装包和 SHA256 文件。

本地更新器不常驻后台，只在插件检查或安装更新时启动；下载的 ZIP 必须通过 SHA256、文件白名单、manifest 名称、版本和固定扩展 ID 校验。

## 联系方式

问题与安全报告请通过 GitHub Issues 提交：
https://github.com/0xuezhang985/985gmgn-helper/issues
