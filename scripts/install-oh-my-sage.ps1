param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\oh-my-sage",
  [string]$Repository = 'https://github.com/allocnode/oh-my-sage.git'
)

$ErrorActionPreference = 'Stop'

if (Test-Path -LiteralPath $InstallRoot) {
  git -C $InstallRoot pull --ff-only
} else {
  git clone $Repository $InstallRoot
}

Push-Location $InstallRoot
try {
  npm install
  npm run build:mcp
  npm link
} finally {
  Pop-Location
}

Write-Output "Oh My Sage MCP 已安装到 $InstallRoot"
