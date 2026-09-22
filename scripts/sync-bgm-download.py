#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 GitHub Release 原始安装器/zip 同步到 bettergmgn.com 的 /dl/，并更新 version.json。
发新版后跑一次，bettergmgn.com 页面的下载就指向最新版（用户下载全程走 bettergmgn.com）。
用法: python scripts/sync-bgm-download.py <version>   # 例 0.42.3
"""
import sys, os, re, io, json, time, hashlib, shlex, tempfile, urllib.request, paramiko

if len(sys.argv) < 2:
    print('用法: python scripts/sync-bgm-download.py <version>'); sys.exit(1)
V = sys.argv[1].lstrip('v')
if not re.fullmatch(r'\d+\.\d+\.\d+', V):
    print('版本格式无效，必须是 X.Y.Z'); sys.exit(1)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = f'985gmgn-helper-setup-v{V}.exe'
ZIP = f'985gmgn-helper-v{V}.zip'
RELEASE_FILES = (EXE, f'{EXE}.sha256', ZIP, f'{ZIP}.sha256')
SITE = os.path.join(HERE, 'site', 'index.html')

# 官网下载必须与公开 Release 同字节，不能上传本机另一时刻重打包的 dist。
release_tmp = tempfile.TemporaryDirectory(prefix=f'985gmgn-v{V}-')
ASSET_DIR = release_tmp.name
release_base = f'https://github.com/0xuezhang985/985gmgn-helper/releases/download/v{V}'
for fn in RELEASE_FILES:
    request = urllib.request.Request(f'{release_base}/{fn}', headers={'User-Agent': '985gmgn-bgm-sync'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, open(os.path.join(ASSET_DIR, fn), 'wb') as output:
            output.write(response.read())
    except Exception as exc:
        print('下载 Release 资产失败:', fn, type(exc).__name__); sys.exit(1)

asset_hashes = {}
for fn in (EXE, ZIP):
    expected = open(os.path.join(ASSET_DIR, f'{fn}.sha256'), encoding='utf-8').read().split()[0].lower()
    actual = hashlib.sha256(open(os.path.join(ASSET_DIR, fn), 'rb').read()).hexdigest()
    if expected != actual:
        print('Release SHA256 不一致:', fn); sys.exit(1)
    asset_hashes[fn] = actual
release_file_hashes = {
    fn: hashlib.sha256(open(os.path.join(ASSET_DIR, fn), 'rb').read()).hexdigest()
    for fn in RELEASE_FILES
}

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
    _i, o, e = ssh.exec_command(cmd, timeout=60)
    output = o.read().decode('utf-8', 'replace') + e.read().decode('utf-8', 'replace')
    if o.channel.recv_exit_status() != 0:
        raise RuntimeError('远端命令失败: ' + output.strip())
    return output
stamp = time.strftime('%Y%m%d-%H%M%S')
backup = f'/opt/bettergmgn/backups/{stamp}'
run(f'mkdir -p /opt/bettergmgn/web/dl {backup}')
run(f"for f in index.html version.json; do if [ -f /opt/bettergmgn/web/$f ]; then cp -a /opt/bettergmgn/web/$f {backup}/$f; fi; done")
release_names = ' '.join(shlex.quote(fn) for fn in RELEASE_FILES)
run(f"for f in {release_names}; do if [ -f /opt/bettergmgn/web/dl/$f ]; then cp -a /opt/bettergmgn/web/dl/$f {backup}/$f; fi; done")
sftp = ssh.open_sftp()
for fn in RELEASE_FILES:
    remote_tmp = f'/opt/bettergmgn/web/dl/.{fn}.{stamp}.tmp'
    sftp.put(os.path.join(ASSET_DIR, fn), remote_tmp)
    remote_hash = run(f"sha256sum {shlex.quote(remote_tmp)} | cut -d' ' -f1").strip()
    if remote_hash != release_file_hashes[fn]:
        run(f'rm -f {shlex.quote(remote_tmp)}')
        print('远端 SHA256 不一致:', fn); sys.exit(1)
    run(f'mv -f {shlex.quote(remote_tmp)} /opt/bettergmgn/web/dl/{shlex.quote(fn)}')
    print('传 Release 原始资产', fn)
site_tmp = f'/opt/bettergmgn/web/.index.html.{stamp}.tmp'
sftp.put(SITE, site_tmp)
print('传 site/index.html')
vj = {"version": V, "exe": f"dl/{EXE}", "zip": f"dl/{ZIP}"}
version_tmp = f'/opt/bettergmgn/web/.version.json.{stamp}.tmp'
with sftp.open(version_tmp, 'w') as f:
    f.write(json.dumps(vj, ensure_ascii=False))
run(f'mv -f {shlex.quote(site_tmp)} /opt/bettergmgn/web/index.html')
run(f'mv -f {shlex.quote(version_tmp)} /opt/bettergmgn/web/version.json')
asset_paths = ' '.join(shlex.quote('/opt/bettergmgn/web/dl/' + fn) for fn in RELEASE_FILES)
run(f'chmod 644 {asset_paths} /opt/bettergmgn/web/version.json /opt/bettergmgn/web/index.html')
print('version.json ->', vj)
# 保留历史下载，避免迁移后的旧链接和回退安装包失效。
local_site_sha = hashlib.sha256(open(SITE, 'rb').read()).hexdigest()
remote_site_sha = run("sha256sum /opt/bettergmgn/web/index.html | cut -d' ' -f1").strip()
if remote_site_sha != local_site_sha:
    print('site/index.html SHA256 不一致'); sys.exit(1)
for fn in RELEASE_FILES:
    remote_hash = run(f"sha256sum /opt/bettergmgn/web/dl/{shlex.quote(fn)} | cut -d' ' -f1").strip()
    if remote_hash != release_file_hashes[fn]:
        print('最终远端 SHA256 不一致:', fn); sys.exit(1)
print('backup ->', backup)
print('site_sha256 ->', remote_site_sha)
print('已保留历史版本，bettergmgn.com 下载已指向 v%s' % V)
ssh.close()
release_tmp.cleanup()
