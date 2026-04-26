# Commit and push this repo only (agents.md-flowchart).
# Usage: .\commit-push.ps1 "Your message"
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Message,
    [string]$Remote = "origin",
    [string]$Branch = "main"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
    Write-Error "No .git here. Run from the agents.md-flowchart project root."
}

git add -A
$status = git status --porcelain
if (-not $status) {
    Write-Host "Nothing to commit."
    git push $Remote $Branch
    exit 0
}

git commit -m $Message
git push $Remote $Branch
Write-Host "Pushed to $Remote $Branch"
