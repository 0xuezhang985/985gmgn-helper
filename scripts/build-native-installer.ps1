param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
$expectedExtensionId = 'bdhjiabmohplopjledcagfaejbgdeonf'

if (-not (Test-Path -LiteralPath $ZipPath)) {
  throw "插件 ZIP 不存在：$ZipPath"
}

$keyBytes = [Convert]::FromBase64String([string]$manifest.key)
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $digest = $sha.ComputeHash($keyBytes)
} finally {
  $sha.Dispose()
}
$alphabet = 'abcdefghijklmnop'
$extensionId = -join (0..15 | ForEach-Object {
  $value = $digest[$_]
  "$($alphabet[$value -shr 4])$($alphabet[$value -band 15])"
})
if ($extensionId -ne $expectedExtensionId) {
  throw "manifest key 对应的扩展 ID 不正确：$extensionId"
}

$frameworkRoots = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$frameworkRoot = $frameworkRoots | Where-Object {
  Test-Path -LiteralPath (Join-Path $_ 'csc.exe')
} | Select-Object -First 1
if (-not $frameworkRoot) {
  throw '未找到 .NET Framework C# 编译器'
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$source = Join-Path $root 'native-updater\Program.cs'
$appManifest = Join-Path $root 'native-updater\app.manifest'
$icon = Join-Path $root 'native-updater\app.ico'
$assemblyInfo = Join-Path $dist 'GeneratedAssemblyInfo.cs'
$output = Join-Path $dist "985gmgn-helper-setup-v$version.exe"

$assemblyVersion = "$version.0"
$assemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("better gmgn 安装器")]
[assembly: AssemblyDescription("better gmgn Native Messaging 更新器")]
[assembly: AssemblyCompany("0xuezhang985")]
[assembly: AssemblyProduct("better gmgn")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
"@
[IO.File]::WriteAllText($assemblyInfo, $assemblySource, [Text.UTF8Encoding]::new($false))

$csc = Join-Path $frameworkRoot 'csc.exe'
$references = @(
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.Web.Extensions.dll',
  'System.Net.Http.dll',
  'System.IO.Compression.dll',
  'System.IO.Compression.FileSystem.dll'
) | ForEach-Object { "/reference:$(Join-Path $frameworkRoot $_)" }

$arguments = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/codepage:65001',
  "/out:$output",
  "/win32icon:$icon",
  "/win32manifest:$appManifest",
  "/resource:$ZipPath,ExtensionPackage.zip"
) + $references + @($source, $assemblyInfo)

try {
  & $csc @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "安装器编译失败，退出码：$LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $assemblyInfo -Force -ErrorAction SilentlyContinue
}

Write-Output "installer=$output"
Write-Output "extension_id=$extensionId"
