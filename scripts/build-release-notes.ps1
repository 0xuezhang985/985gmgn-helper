param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($Tag -notmatch '^v\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "版本标签格式无效：$Tag"
}

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root "release-notes\$Tag.md"
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "缺少完整版本说明：release-notes/$Tag.md"
}

$content = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8).Trim()
$requiredSections = @(
  '# 985gmgn助手',
  '## 本版重点',
  '## 安装方法',
  '## 使用说明',
  '## 更新方式',
  '## 安全与隐私'
)
foreach ($section in $requiredSections) {
  if (-not $content.Contains($section)) {
    throw "版本说明缺少章节：$section"
  }
}
if (-not $content.Contains($Tag)) {
  throw "版本说明标题未包含标签：$Tag"
}
if ($content.Length -lt 800) {
  throw "版本说明过短，必须提供详细介绍和使用说明：$($content.Length) 字符"
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
[IO.File]::WriteAllText($OutputPath, "$content`n", [Text.UTF8Encoding]::new($false))

Write-Output "release_notes=$OutputPath"
Write-Output "tag=$Tag"
Write-Output "characters=$($content.Length)"
