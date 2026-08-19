# 隐私说明

better gmgn 只在用户访问 `https://gmgn.ai/` 时运行，用于读取当前页面已经展示的代币、Dev 与喊单信息，并在页面上增加高亮、战绩、收藏和黑名单界面。

## 数据处理

- 重点 Dev 地址、备注、功能开关、颜色和喊单黑名单仅保存在浏览器本地 `chrome.storage.local`。
- 插件不收集、上传、出售或共享用户数据。
- 插件不读取钱包私钥、助记词、密码或 API Key。
- 插件不包含远程执行代码。

## 网络访问

插件页面仅声明 `https://gmgn.ai/*` 页面权限。本地更新器只访问以下固定地址：

- `https://api.github.com/repos/0xuezhang985/985gmgn-helper/releases/latest`：读取最新版本。
- `https://github.com/0xuezhang985/985gmgn-helper/releases/download/`：下载发布包和 SHA256 文件。

更新请求不包含 Dev 地址、备注、喊单黑名单或其他用户配置。本地更新器不常驻后台，只在插件检查或安装更新时启动；下载的 ZIP 必须通过 SHA256、文件白名单、manifest 名称、版本和固定扩展 ID 校验。

## 联系方式

问题与安全报告请通过 GitHub Issues 提交：
https://github.com/0xuezhang985/985gmgn-helper/issues
