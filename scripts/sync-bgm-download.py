#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把当前 dist 里的安装器/zip 同步到 985monitor 的 /bgm/dl/，并更新 version.json。
发新版后跑一次，/bgm/ 页面的下载就指向最新版（全程走 985monitor，不经 GitHub）。
用法: python scripts/sync-bgm-download.py <version>   # 例 0.42.3
"""
import sys, os, re, io, json, time, hashlib, paramiko

if len(sys.argv) < 2:
    print('用法: python scripts/sync-bgm-download.py <version>'); sys.exit(1)
V = sys.argv[1].lstrip('v')
if not re.fullmatch(r'\d+\.\d+\.\d+', V):
    print('版本格式无效，必须是 X.Y.Z'); sys.exit(1)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(HERE, 'dist')
EXE = f'985gmgn-helper-setup-v{V}.exe'
ZIP = f'985gmgn-helper-v{V}.zip'
SITE = os.path.join(HERE, 'site', 'index.html')
for fn in (EXE, ZIP):
    if not os.path.exists(os.path.join(DIST, fn)):
        print('缺文件:', fn, '（先跑 build-release.ps1）'); sys.exit(1)

# 服务器凭据从 985monitor 部署器读，不写死
src = io.open(r'F:/xuhuohua/_deploy_widget_stage2.py', encoding='utf-8').read()
HOST = re.search(r'HOST\s*=\s*["\']([^"\']+)', src).group(1)
USER = re.search(r'USER\s*=\s*["\']([^"\']+)', src).group(1)
PW = re.search(r'PW\s*=\s*["\']([^"\']+)', src).group(1)
if not os.path.exists(SITE):
    print('缺文件: site/index.html'); sys.exit(1)
ssh = paramiko.SSHClient()
known_hosts = os.path.expanduser(r'~/.ssh/known_hosts')
ssh.load_host_keys(known_hosts)
ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
ssh.connect(HOST, username=USER, password=PW, timeout=15)
def run(cmd):
    _i, o, e = ssh.exec_command(cmd, timeout=60); return o.read().decode('utf-8','replace') + e.read().decode('utf-8','replace')
stamp = time.strftime('%Y%m%d-%H%M%S')
backup = f'/opt/x-monitor-widget/web/bgm/backup-{stamp}'
run(f'mkdir -p /opt/x-monitor-widget/web/bgm/dl {backup}')
run(f"for f in index.html version.json; do if [ -f /opt/x-monitor-widget/web/bgm/$f ]; then cp -a /opt/x-monitor-widget/web/bgm/$f {backup}/$f; fi; done")
sftp = ssh.open_sftp()
for fn in (EXE, ZIP):
    sftp.put(os.path.join(DIST, fn), f'/opt/x-monitor-widget/web/bgm/dl/{fn}'); print('传', fn)
sftp.put(SITE, '/opt/x-monitor-widget/web/bgm/index.html'); print('传 site/index.html')
vj = {"version": V, "exe": f"dl/{EXE}", "zip": f"dl/{ZIP}"}
with sftp.open('/opt/x-monitor-widget/web/bgm/version.json', 'w') as f:
    f.write(json.dumps(vj, ensure_ascii=False))
run('chmod 644 /opt/x-monitor-widget/web/bgm/dl/* /opt/x-monitor-widget/web/bgm/version.json /opt/x-monitor-widget/web/bgm/index.html')
print('version.json ->', vj)
# 清理旧版本文件（只留当前版，避免 dl 目录堆积）
run(f"cd /opt/x-monitor-widget/web/bgm/dl && ls | grep -v -F '{EXE}' | grep -v -F '{ZIP}' | xargs -r rm -f")
local_site_sha = hashlib.sha256(open(SITE, 'rb').read()).hexdigest()
remote_site_sha = run("sha256sum /opt/x-monitor-widget/web/bgm/index.html | cut -d' ' -f1").strip()
if remote_site_sha != local_site_sha:
    print('site/index.html SHA256 不一致'); sys.exit(1)
print('backup ->', backup)
print('site_sha256 ->', remote_site_sha)
print('已清理旧版本，/bgm/ 下载已指向 v%s' % V)
ssh.close()
