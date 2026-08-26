#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把当前 dist 里的安装器/zip 同步到 985monitor 的 /bgm/dl/，并更新 version.json。
发新版后跑一次，/bgm/ 页面的下载就指向最新版（全程走 985monitor，不经 GitHub）。
用法: python scripts/sync-bgm-download.py <version>   # 例 0.42.3
"""
import sys, os, re, io, json, paramiko

if len(sys.argv) < 2:
    print('用法: python scripts/sync-bgm-download.py <version>'); sys.exit(1)
V = sys.argv[1].lstrip('v')
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(HERE, 'dist')
EXE = f'985gmgn-helper-setup-v{V}.exe'
ZIP = f'985gmgn-helper-v{V}.zip'
for fn in (EXE, ZIP):
    if not os.path.exists(os.path.join(DIST, fn)):
        print('缺文件:', fn, '（先跑 build-release.ps1）'); sys.exit(1)

# 服务器凭据从 985monitor 部署器读，不写死
src = io.open(r'F:/xuhuohua/_deploy_widget_stage2.py', encoding='utf-8').read()
HOST = re.search(r'HOST\s*=\s*["\']([^"\']+)', src).group(1)
USER = re.search(r'USER\s*=\s*["\']([^"\']+)', src).group(1)
PW = re.search(r'PW\s*=\s*["\']([^"\']+)', src).group(1)
ssh = paramiko.SSHClient(); ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PW, timeout=15)
def run(cmd):
    _i, o, e = ssh.exec_command(cmd, timeout=60); return o.read().decode('utf-8','replace') + e.read().decode('utf-8','replace')
run('mkdir -p /opt/x-monitor-widget/web/bgm/dl')
sftp = ssh.open_sftp()
for fn in (EXE, ZIP):
    sftp.put(os.path.join(DIST, fn), f'/opt/x-monitor-widget/web/bgm/dl/{fn}'); print('传', fn)
vj = {"version": V, "exe": f"dl/{EXE}", "zip": f"dl/{ZIP}"}
with sftp.open('/opt/x-monitor-widget/web/bgm/version.json', 'w') as f:
    f.write(json.dumps(vj, ensure_ascii=False))
run('chmod 644 /opt/x-monitor-widget/web/bgm/dl/* /opt/x-monitor-widget/web/bgm/version.json')
print('version.json ->', vj)
# 清理旧版本文件（只留当前版，避免 dl 目录堆积）
run(f"cd /opt/x-monitor-widget/web/bgm/dl && ls | grep -v -F '{EXE}' | grep -v -F '{ZIP}' | xargs -r rm -f")
print('已清理旧版本，/bgm/ 下载已指向 v%s' % V)
ssh.close()
