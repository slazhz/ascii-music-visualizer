@echo off
title Install the Wallpaper Bridge for Spotify (optional, unofficial)
cd /d "%~dp0"
echo This installs Spicetify (a third-party Spotify mod) and the Wallpaper Bridge extension.
echo It is only needed for canvases / exact Spotify tracklists. It is NOT made or endorsed by Spotify,
echo and modifying the Spotify app may go against Spotify's terms. Use at your own risk.
echo.
choice /C YN /M "Continue"
if errorlevel 2 exit /b 0
if not exist "wallpaper-bridge.js" (echo wallpaper-bridge.js is missing from this folder. & pause & exit /b 1)
set "SP=%LOCALAPPDATA%\spicetify\spicetify.exe"
if not exist "%SP%" (
  echo Installing Spicetify with its official installer from https://spicetify.app ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex"
)
if not exist "%SP%" (echo Spicetify did not install. See https://spicetify.app & pause & exit /b 1)
"%SP%" config > nul 2>&1
set "EXT=%APPDATA%\spicetify\Extensions"
if not exist "%EXT%" mkdir "%EXT%"
copy /Y "wallpaper-bridge.js" "%EXT%\" >nul
"%SP%" config extensions wallpaper-bridge.js
"%SP%" backup apply || "%SP%" apply
echo.
echo Done. Spotify restarts with the bridge. http://127.0.0.1:7777 should show "Spicetify bridge: connected".
echo To remove it later: run  "%SP%" config extensions wallpaper-bridge.js-  then  "%SP%" apply
pause
