$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'
$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ('985gmgn-version-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$isolated = Join-Path $temp 'Install'
$source = [IO.File]::ReadAllText((Join-Path $root 'native-updater\Program.cs'), [Text.Encoding]::UTF8)
$start = $source.IndexOf('internal static readonly string InstallRoot =')
$end = $source.IndexOf(';', $start) + 1
if ($start -lt 0 -or $end -le $start) { throw '无法隔离测试安装目录' }
$source = $source.Substring(0, $start) + ('internal static readonly string InstallRoot = @"' + $isolated + '";') + $source.Substring($end)
$cs = Join-Path $temp 'Program.cs'
[IO.File]::WriteAllText($cs, $source, [Text.UTF8Encoding]::new($false))
$info = Join-Path $temp 'AssemblyInfo.cs'
[IO.File]::WriteAllText($info, '[assembly: System.Reflection.AssemblyVersion("0.46.67.0")]', [Text.UTF8Encoding]::new($false))
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$exe = Join-Path $temp 'test-updater.exe'
$zip = Join-Path $root 'dist\public-v0.46.67\985gmgn-helper-v0.46.67.zip'
$refs = @('System','System.Core','System.Drawing','System.Windows.Forms','System.Web.Extensions','System.IO.Compression','System.IO.Compression.FileSystem') | ForEach-Object { '/reference:' + (Join-Path $framework ($_ + '.dll')) }
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /codepage:65001 "/out:$exe" "/resource:$zip,ExtensionPackage.zip" @refs $cs $info
if ($LASTEXITCODE -ne 0) { throw '测试更新器编译失败' }
@'
import sys,subprocess,struct,json,zipfile,hashlib
from pathlib import Path
exe,root,zp=map(Path,sys.argv[1:]);root.mkdir()
with zipfile.ZipFile(zp) as z:z.extractall(root/'Extension')
(root/'install.json').write_text('{}',encoding='utf8')
def call(action,origin='chrome-extension://bdhjiabmohplopjledcagfaejbgdeonf/',**kw):
    p=subprocess.Popen([str(exe),origin],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    msg=json.dumps(dict(action=action,**kw)).encode();out,_=p.communicate(struct.pack('<I',len(msg))+msg,timeout=180)
    assert len(out)>=4
    n=struct.unpack('<I',out[:4])[0];return json.loads(out[4:4+n])
def version():return json.loads((root/'Extension/manifest.json').read_text(encoding='utf8'))['version']
p=subprocess.run([str(exe),'--self-test'],creationflags=subprocess.CREATE_NO_WINDOW,timeout=30)
assert p.returncode==0,p.returncode
print('PASS: 原生校验/资源白名单/摘要/错误 SHA/撤回版本自检')
assert call('capabilities')['protocolVersion']==2
assert not call('capabilities',origin='chrome-extension://wrong/')['ok']
assert not call('rollback',version='../bad')['ok']
assert not call('rollback',version='0.46.67')['ok']
assert version()=='0.46.67'
print('PASS: 拒绝错误来源/无效目标/非降级目标，不改安装文件')
r=call('rollback',version='0.46.66');assert r['ok'],r
assert version()=='0.46.66';assert (root/'skipped-version.txt').read_text()=='0.46.67'
assert list((root/'Backups').glob('0.46.67-*'))
print('PASS: 官方 v0.46.66 包回退成功，备份存在并记录跳过 v0.46.67')
s=call('check',currentVersion='0.46.66');assert s['ok'],s
if s['latestVersion']=='0.46.67':assert s['skipped'] and not s['updateAvailable'],s
else:assert s['updateAvailable'] and not s['skipped'],s
assert not call('update',version='0.46.67')['ok']
assert call('skip',version='')['ok']
r=call('update',version='0.46.67');assert r['ok'],r
with zipfile.ZipFile(zp) as z:
    for name in z.namelist():assert (root/'Extension'/name).read_bytes()==z.read(name),name
print('PASS: 跳过阻止升回；恢复后重装 v0.46.67，21 文件与正式包一致')
h=call('history',currentVersion='0.46.69');assert h['ok'],h
versions=[x['version'] for x in h['versions']];assert '0.46.67' in versions and '0.46.68' not in versions
print('PASS: 历史版本来自官方包，排除已撤回 v0.46.68')
print('Isolated test directory: '+str(root))
'@ | python - $exe $isolated $zip
if ($LASTEXITCODE -ne 0) { throw '原生版本管理回归失败' }
