@echo off
rem DENTIVA — installer launcher.
rem Double-click this file to install Dentiva for the current Windows user.
setlocal
set PS=powershell.exe
where pwsh.exe >nul 2>nul && set PS=pwsh.exe
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Dentiva could not be installed. The message above explains why.
  pause
  exit /b 1
)
echo.
pause
