<#
  DENTIVA — uninstaller

  Stops a running instance, removes the program folder, the shortcuts and the
  "Apps & features" entry. Your clinic data is kept unless you pass -RemoveData,
  because an uninstall must never destroy patient records by accident.

  Usage
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData -Force
#>
[CmdletBinding()]
param(
  [switch]$RemoveData,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$appName = 'Dentiva'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $installDir 'DENTIVA.exe'
$dataDir = if ($env:DENTIVA_DATA_DIR) { $env:DENTIVA_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Dentiva' }

Write-Host "Removing $appName" -ForegroundColor Cyan

if (Test-Path $exePath) {
  try {
    & $exePath --stop | Out-Null
    Write-Host '  running instance stopped'
  } catch {
    Write-Host '  no running instance to stop'
  }
}

foreach ($link in @(
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$appName.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk")
)) {
  if ($link -and (Test-Path $link)) { Remove-Item $link -Force; Write-Host "  removed $link" }
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Dentiva'
if (Test-Path $uninstallKey) { Remove-Item $uninstallKey -Recurse -Force; Write-Host '  removed the Apps & features entry' }

if ($RemoveData) {
  if (-not $Force) {
    Write-Host ''
    Write-Warning "This deletes every patient record, invoice, attachment and backup in $dataDir"
    $answer = Read-Host 'Type DELETE to confirm'
    if ($answer -ne 'DELETE') {
      Write-Host 'Clinic data was kept.'
      $RemoveData = $false
    }
  }
  if ($RemoveData -and (Test-Path $dataDir)) {
    Remove-Item $dataDir -Recurse -Force
    Write-Host "  removed clinic data at $dataDir"
  }
} else {
  Write-Host "  clinic data kept at $dataDir"
}

# The program folder may still hold files the user added; remove it last.
if ($installDir -and (Test-Path $installDir)) {
  try {
    Remove-Item $installDir -Recurse -Force
    Write-Host "  removed $installDir"
  } catch {
    Write-Warning "Some files in $installDir are in use and were left behind."
  }
}

Write-Host ''
Write-Host "$appName has been removed." -ForegroundColor Green
