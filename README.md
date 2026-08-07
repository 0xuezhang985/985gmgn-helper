# 985gmgn助手

Chrome Manifest V3 插件，用于在 GMGN BSC 战壕三列中高亮指定 Dev 发射的代币。

- GitHub：https://github.com/0xuezhang985/985gmgn-helper
- 最新版本：https://github.com/0xuezhang985/985gmgn-helper/releases/latest

## 功能

- 在插件 Popup 中维护重点 Dev 钱包，一行一个，可附加备注。
- 配置页可分别开关重点 Dev 高亮、Dev 战绩常显、悬停详情、详情页一键收藏和喊单黑名单。
- 配置页提供“一键检查升级”，通过 Chrome 官方更新通道检查并立即应用已下载的新版本。
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

1. 从 [GitHub Releases](https://github.com/0xuezhang985/985gmgn-helper/releases/latest) 下载最新版 ZIP 并解压。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压后的目录。
5. 打开 `https://gmgn.ai/?chain=bsc`，点击插件图标配置 Dev 钱包。

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

- GitHub Releases 用于公开源码和下载每个版本的 ZIP 安装包。
- Windows/macOS 的 Chrome 不允许普通用户从 GitHub 自托管扩展完成静默安装或自动升级。
- 真正的一键升级和后台自动更新需要把同一扩展发布到 Chrome Web Store；发布后，插件内的“一键检查升级”按钮会调用 Chrome 官方更新 API。
