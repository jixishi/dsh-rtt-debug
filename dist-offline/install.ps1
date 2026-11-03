<#
.SYNOPSIS
  dsh-rtt-debug 插件离线一键安装向导 (Windows PowerShell)
.DESCRIPTION
  自动将本插件安装并挂载到 DeepSeek Harness 的 Web 运行配置中，并注册 AI 技能。
#>
param(
  [string]$ProfilePath = "$HOME\.dsh\profiles\web"
)

$ErrorActionPreference = "Stop"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  dsh-rtt-debug 插件离线安装向导" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$CurrentDir = $PSScriptRoot
$TgzPath = Join-Path $CurrentDir "dsh-rtt-debug-0.1.0.tgz"

if (-not (Test-Path $TgzPath)) {
  Write-Error "未找到安装包文件: $TgzPath"
}

Write-Host "目标 DSH Profile: $ProfilePath" -ForegroundColor Yellow

if (-not (Test-Path $ProfilePath)) {
  Write-Error "DSH Profile 目录不存在: $ProfilePath`n请确保已安装 DeepSeek Harness 并运行过 dsh web。"
}

$NodeModules = Join-Path $ProfilePath "node_modules"
$TargetPluginDir = Join-Path $NodeModules "dsh-rtt-debug"

# 1. 确保 node_modules 目录存在
if (-not (Test-Path $NodeModules)) {
  New-Item -ItemType Directory -Path $NodeModules | Out-Null
}

# 2. 如果已存在符号链接或旧目录，先清理
if (Test-Path $TargetPluginDir) {
  Write-Host "[1/4] 清理已有安装目录..." -ForegroundColor Gray
  Remove-Item -Recurse -Force $TargetPluginDir
}

# 3. 解压 .tgz 到目标目录
Write-Host "[2/4] 解压安装插件到 node_modules/dsh-rtt-debug..." -ForegroundColor Green
$TempExtract = Join-Path $env:TEMP "dsh-rtt-debug-extract-$(Get-Random)"
New-Item -ItemType Directory -Path $TempExtract | Out-Null
try {
  tar -xzf $TgzPath -C $TempExtract
  Move-Item (Join-Path $TempExtract "package") $TargetPluginDir
} finally {
  if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract -ErrorAction SilentlyContinue }
}

# 4. 挂载到 DSH Web 的 package.json (dsh.profile.bundles)
Write-Host "[3/4] 注册插件到 profile package.json (dsh.profile.bundles)..." -ForegroundColor Green
$ProfilePkgPath = Join-Path $ProfilePath "package.json"
if (Test-Path $ProfilePkgPath) {
  $pkg = Get-Content $ProfilePkgPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (-not $pkg.dsh) { $pkg | Add-Member -MemberType NoteProperty -Name "dsh" -Value ([PSCustomObject]@{}) }
  if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -MemberType NoteProperty -Name "profile" -Value ([PSCustomObject]@{}) }
  if (-not $pkg.dsh.profile.bundles) {
    $pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name "bundles" -Value @()
  }
  $bundles = [System.Collections.Generic.List[string]]::new($pkg.dsh.profile.bundles)
  if (-not $bundles.Contains("dsh-rtt-debug")) {
    $bundles.Add("dsh-rtt-debug")
    $pkg.dsh.profile.bundles = $bundles.ToArray()
    $pkg | ConvertTo-Json -Depth 10 | Set-Content -Path $ProfilePkgPath -Encoding utf8
    Write-Host "      已追加 dsh-rtt-debug 到 bundles" -ForegroundColor Gray
  } else {
    Write-Host "      bundles 中已有 dsh-rtt-debug，跳过追加" -ForegroundColor Gray
  }
}

# 5. 安装技能 (Skill) 到 ~/.dsh/skills/rtt-debug 与 ~/.agents/skills/rtt-debug
Write-Host "[4/4] 安装 rtt-debug AI 技能..." -ForegroundColor Green
$SkillSrc = Join-Path $TargetPluginDir "skills\rtt-debug\SKILL.md"
$UserSkillDir = Join-Path $HOME ".dsh\skills\rtt-debug"
$UserSkillAgentsDir = Join-Path $HOME ".agents\skills\rtt-debug"

if (Test-Path $SkillSrc) {
  try {
    if (-not (Test-Path $UserSkillDir)) { New-Item -ItemType Directory -Force -Path $UserSkillDir | Out-Null }
    Copy-Item $SkillSrc (Join-Path $UserSkillDir "SKILL.md") -Force
    Write-Host "      已安装至: $UserSkillDir\SKILL.md" -ForegroundColor Gray
  } catch {}
  try {
    if (-not (Test-Path $UserSkillAgentsDir)) { New-Item -ItemType Directory -Force -Path $UserSkillAgentsDir | Out-Null }
    Copy-Item $SkillSrc (Join-Path $UserSkillAgentsDir "SKILL.md") -Force
    Write-Host "      已安装至: $UserSkillAgentsDir\SKILL.md" -ForegroundColor Gray
  } catch {}
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  安装成功！" -ForegroundColor Green
Write-Host "  请重启 DSH Web 实例以生效: dsh web" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
