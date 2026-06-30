$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModuleDir = Split-Path -Parent $ScriptDir
Set-Location $ModuleDir

if (-not (Test-Path ".\node_modules")) {
  npm install
}

node .\src\server.js
