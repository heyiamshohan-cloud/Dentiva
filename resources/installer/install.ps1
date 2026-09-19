<#
  DENTIVA — installer (per-user, no administrator rights required)

  Copies the application into %LOCALAPPDATA%\Programs\Dentiva, creates Start
  Menu and Desktop shortcuts and registers an entry in "Apps & features" so the
  installation can be removed the normal Windows way.

  Patient data is NOT touched by the installer: the clinic database stays in
  %LOCALAPPDATA%\Dentiva (or wherever --data points) and survives upgrades,
  reinstalls and uninstalls.

  Usage
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -AllUsers      # needs admin
    powershell -ExecutionPolicy Bypass -File install.ps1 -Desktop:$false
    powershell -ExecutionPolicy Bypass -File install.ps1 -Portable      # USB stick mode
#>
[CmdletBinding()]
param(
  [switch]$AllUsers,
  [switch]$Portable,
  [bool]$Desktop = $true,
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$appName = 'Dentiva'
$appVersion = '1.0.0'
$publisher = 'Md. Shohan Khan'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeName = 'DENTIVA.exe'
$exePath = Join-Path $sourceDir $exeName

function Write-Step($message) { Write-Host "  $message" }

if (-not (Test-Path $exePath)) {
  throw "$exeName was not found next to this script ($sourceDir). Extract the whole archive first."
}

if ($Portable) {
  # Portable mode keeps everything beside the executable: no shortcuts, no
  # registry entries, nothing in the user profile.
  $marker = Join-Path $sourceDir 'data'
  if (-not (Test-Path $marker)) { New-Item -ItemType Directory -Path $marker | Out-Null }
  Write-Host "$appName is ready in portable mode." -ForegroundColor Green
  Write-Step "Application : $exePath"
  Write-Step "Data folder : $marker"
  Write-Host 'Nothing was installed. Start the application with DENTIVA.exe.'
  exit 0
}

if (-not $InstallDir) {
  if ($AllUsers) {
    $InstallDir = Join-Path $env:ProgramFiles $appName
  } else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$appName"
  }
}

Write-Host "Installing $appName $appVersion" -ForegroundColor Cyan
Write-Step "From : $sourceDir"
Write-Step "To   : $InstallDir"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# Copy the program files (never the data folder, never an existing database).
$skip = @('data', 'dist', '.git')
Get-ChildItem -Path $sourceDir -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
  $target = Join-Path $InstallDir $_.Name
  Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
}

$installedExe = Join-Path $InstallDir $exeName

function New-Shortcut([string]$Path, [string]$Target) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.WorkingDirectory = Split-Path -Parent $Target
  # A cross-compiled executable has no icon resource, so the shortcuts point at
  # the shipped icon file; a build made on Windows embeds it and this is a no-op
  # that still renders identically.
  $iconFile = Join-Path (Split-Path -Parent $Target) 'icon.ico'
  if (Test-Path $iconFile) { $shortcut.IconLocation = $iconFile }
  else { $shortcut.IconLocation = "$Target,0" }
  $shortcut.Description = "$appName — dental practice management"
  $shortcut.Save()
}

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
New-Shortcut (Join-Path $startMenuDir "$appName.lnk") $installedExe
Write-Step 'Start Menu shortcut created'

if ($Desktop) {
  $desktopDir = [Environment]::GetFolderPath('Desktop')
  if ($desktopDir) {
    New-Shortcut (Join-Path $desktopDir "$appName.lnk") $installedExe
    Write-Step 'Desktop shortcut created'
  }
}

# Apps & features entry (per user, so no administrator rights are needed).
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Dentiva'
New-Item -Path $uninstallKey -Force | Out-Null
$uninstallScript = Join-Path $InstallDir 'uninstall.ps1'
Set-ItemProperty -Path $uninstallKey -Name 'DisplayName' -Value $appName
Set-ItemProperty -Path $uninstallKey -Name 'DisplayVersion' -Value $appVersion
Set-ItemProperty -Path $uninstallKey -Name 'Publisher' -Value $publisher
Set-ItemProperty -Path $uninstallKey -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $uninstallKey -Name 'DisplayIcon' -Value $installedExe
Set-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name 'UninstallString' `
  -Value "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$uninstallScript`""
Write-Step 'Registered in Apps & features'

Write-Host ''
Write-Host "$appName $appVersion installed successfully." -ForegroundColor Green
Write-Step "Application : $installedExe"
Write-Step "Clinic data : %LOCALAPPDATA%\Dentiva  (kept when you uninstall)"
Write-Host 'Open Dentiva from the Start Menu. The first launch asks for your clinic details.'
