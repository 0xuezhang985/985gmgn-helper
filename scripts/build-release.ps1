$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
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
  'styles.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
)

foreach ($relativePath in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $relativePath))) {
    throw "发布文件不存在：$relativePath"
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
Write-Output "package=$zipPath"
Write-Output "version=$version"
Write-Output "sha256=$hash"
