# 985gmgn助手

Chrome Manifest V3 插件，用于在 GMGN BSC 战壕三列中高亮指定 Dev 发射的代币。

- GitHub：https://github.com/0xuezhang985/985gmgn-helper
- 最新版本：https://github.com/0xuezhang985/985gmgn-helper/releases/latest

## 功能

- 在插件 Popup 中维护重点 Dev 钱包，一行一个，可附加备注。
- 配置页可分别开关重点 Dev 高亮、Dev 战绩常显、悬停详情、详情页一键收藏和喊单黑名单。
- 配置页显示 GitHub 最新版本；发现新版后可查看 Release 页面或调用本地更新器一键升级。
- 插件图标通过绿色 `UP` 角标提醒新版。
- 在 GMGN 代币详情的“开发者代币”面板中一键收藏 GMGN Creator，备注自动写为“当前代币名 + dev”。
- 重点 Dev 的代币卡片显示醒目边框和标签。
- 战壕卡片始终直接显示 Dev 备注，无需悬停。
- 每张战壕卡片底部常显 Dev 战绩：发币迁移数、发币总数、迁移比例。
- Dev 战绩标签按迁移比例连续变亮：0% 为暗色，比例越高越亮。
- 喊单面板提供黑名单管理，每条喊单可一键屏蔽喊单人并随时解除。
- 被屏蔽人的喊单卡片和顶部宣言通知都会隐藏；名单保存在 Chrome 本地。
- 鼠标悬停卡片时显示：
  - Dev 发币迁移数
  - Dev 发币总数
  - Dev 发币迁移比例
- 数据直接读取当前 GMGN 战壕卡片，不保存或使用 API Key。
- 设置只保存在 Chrome 本地 `storage.local`。

## 安装

1. 从 [GitHub Releases](https://github.com/0xuezhang985/985gmgn-helper/releases/latest) 下载 `985gmgn-helper-setup-v版本.exe`。
2. 运行安装器并点击“安装 / 修复”。安装器会打开插件目录和扩展程序页面。
3. 在 Chrome/Edge 扩展程序页面打开“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择安装器显示的目录：`%LOCALAPPDATA%\985gmgn-helper\Extension`。
5. 打开 `https://gmgn.ai/?chain=bsc`，点击插件图标配置 Dev 钱包。

安装器目前未购买代码签名证书，Windows SmartScreen 可能显示发布者未知。可下载同名 `.sha256` 文件核对安装器摘要。用户也可以继续下载 ZIP 手动安装，但这种方式不能使用一键升级。

## 配置格式

```text
0x1111111111111111111111111111111111111111 团队 A
0x2222222222222222222222222222222222222222
```

迁移比例优先用“迁移数 ÷ 发币总数”计算；只有计数缺失时才回退到 GMGN 返回的比例字段。

## 兼容范围

- Chrome 111+
- GMGN BSC 战壕页面

插件使用 GMGN 当前 React 卡片数据结构。若 GMGN 更换卡片组件或字段名，需要同步更新选择器/数据桥接逻辑。

## 更新说明

- 安装器会把本地更新器注册为 Chrome/Edge Native Messaging 主机；更新器不常驻后台。
- 插件启动时及每 6 小时检查一次 GitHub 最新 Release。发现新版时，插件图标显示 `UP`，配置页显示版本和 GitHub 链接。
- 点击“一键升级”后，本地更新器下载 ZIP、核验 SHA256 与文件白名单、备份旧版并替换插件目录，然后重载插件。
- 更新源固定为 `0xuezhang985/985gmgn-helper`，安装包不能包含白名单外文件。
- 如果本地更新器不存在，配置页按钮会改为打开 GitHub 最新 Release，不会假装升级成功。
