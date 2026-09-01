$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
# 先查空文件：脚本改写出错（以写模式打开的同时读同一个文件）会把它截成 0 字节，
# 那样下面的版本号检查只会报"版本号无效"，看不出真正原因。
if ((Get-Item -LiteralPath $manifestPath).Length -eq 0) {
  throw "manifest.json 是空文件（多半是改写脚本把它截断了），请从上一个 tag 恢复"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "manifest.json 版本号无效：$version"
}

$files = @(
  'manifest.json',
  'background.js',
  'page-bridge.js',
  'content.js',
  'debot-bridge.js',
  'debot-content.js',
  'fomo-early.js',
  'styles.css',
  'debot-styles.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
)

foreach ($relativePath in $files) {
  $fullPath = Join-Path $root $relativePath
  if (-not (Test-Path -LiteralPath $fullPath)) {
    throw "发布文件不存在：$relativePath"
  }
  # 空文件是脚本改写出错的典型后果（比如以写模式打开文件把它先截断了），
  # 打进包里要等用户装的时候才炸，这里直接拦下。
  if ((Get-Item -LiteralPath $fullPath).Length -eq 0) {
    throw "发布文件为空：$relativePath"
  }
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zipPath = Join-Path $dist "985gmgn-helper-v$version.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open(
  $zipPath,
  [IO.Compression.ZipArchiveMode]::Create
)
try {
  foreach ($relativePath in $files) {
    $source = Join-Path $root $relativePath
    $entryName = $relativePath.Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $source,
      $entryName,
      [IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
& (Join-Path $PSScriptRoot 'build-native-installer.ps1') -ZipPath $zipPath
$installerPath = Join-Path $dist "985gmgn-helper-setup-v$version.exe"
if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "安装器不存在：$installerPath"
}
$installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()

$utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText(
  "$zipPath.sha256",
  "$hash  $([IO.Path]::GetFileName($zipPath))`n",
  $utf8NoBom
)
[IO.File]::WriteAllText(
  "$installerPath.sha256",
  "$installerHash  $([IO.Path]::GetFileName($installerPath))`n",
  $utf8NoBom
)

Write-Output "package=$zipPath"
Write-Output "version=$version"
Write-Output "sha256=$hash"
Write-Output "installer=$installerPath"
Write-Output "installer_sha256=$installerHash"
