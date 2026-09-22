# bettergmgn.com

介绍和下载官网：<https://bettergmgn.com/>。不承载 985monitor 的账号、API 或 SSE。

## 线上位置

- 服务器：现有 985monitor 主机 `43.103.49.124`，SSH 凭据仅从 `F:/xuhuohua/_deploy_widget_stage2.py` 在运行时读取，禁止输出。
- 独立静态根：`/opt/bettergmgn/web/`。只发布 `index.html`、`version.json`、`icon128.png` 和经过校验的 `dl/` 安装包及 SHA256 文件。
- nginx：`/etc/nginx/sites-available/bettergmgn`，软链接到 `sites-enabled/bettergmgn`；模板见本目录 `nginx-bettergmgn.conf`。不新增后端服务，不重启监控服务。
- DNS：根域名和 `www` 的 A 记录指向上述主机，DNS-only。HTTP 和 www 统一 301 到 HTTPS 根域名。
- TLS：Let's Encrypt，证书名 `bettergmgn.com`，同时包含根域名和 www。使用 `/var/www/bettergmgn-acme` webroot；`certbot.timer` 自动续期，deploy hook 重载 nginx。私钥不复制到仓库。
- 兼容入口：985monitor 的 `/bgm` 和 `/bgm/…` 301 到新官网，保留子路径及查询参数；旧目录及原安装包保留，不删除。

## 后续版本

1. 用户明确要求发布后，完成 GitHub Release，并确认 ZIP、EXE、两个 `.sha256` 文件齐全。
2. 更新本地 `site/index.html` 的公开版本回退值；未发布的本地试用版本不得出现在公开下载链接中。
3. 运行 `python scripts/sync-bgm-download.py X.Y.Z`，仍只取 GitHub 原始 Release 资产，不上传本地临时构建。脚本备份到 `/opt/bettergmgn/backups/`，逐文件校验后发布，保留历史安装包。
4. 验证公网上的主页、`version.json`、安装包 SHA256，以及旧 `/bgm` 下载地址的跳转。介绍页改动不需要向插件用户推送版本提示。

## 首次迁移 / 回退

2026-09-20 已迁移官网，公开下载仍为 v0.46.99；本地插件 v0.46.101 尚未发布。

迁移备份：`/opt/bettergmgn/backups/migration-20260920-010240/`，包含旧站 HTML、版本元数据、985monitor nginx 原配置和新站的 HTTP 初始配置。

如需回退旧入口，先确认 `/etc/nginx/sites-enabled/x-monitor-widget-domain` 没有其他任务的新改动，只移除 `BEGIN/END bettergmgn-site-migration` 之间的新增规则，执行 `nginx -t` 成功后 reload。不要整文件覆盖后续配置，不删除证书、DNS、旧下载或新站目录。原 `/opt/x-monitor-widget/web/bgm/` 可直接继续服务。

本地验证：`node scripts/verify-bettergmgn-site.mjs`（可用 `PLAYWRIGHT_MODULE` 指定 Playwright 路径），以及全部 `scripts/verify-*.mjs`。

## 官网文案更新

2026.09.20.2 为独立的网站修订号：完整 English / 中文介绍，首次默认英文，记住手动选择。只需备份并原子替换 `index.html`，不覆盖 `version.json` 或下载包，不触发扩展发布。网站变更记录见 `site/CHANGELOG.md`，新增语言测试为 `node scripts/verify-site-language.mjs`。
