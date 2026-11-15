@echo off
title ACV helper - start automatically
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
set "ACV_DIR=%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ACV helper.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut($env:LNK); $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'; $s.Arguments = [char]34 + $env:ACV_DIR + 'start-hidden.vbs' + [char]34; $s.WorkingDirectory = $env:ACV_DIR; $s.Description = 'ASCII Music Visualizer helper'; $s.Save()"
if not exist "%LNK%" (echo Could not create the startup shortcut. & pause & exit /b 1)
echo The helper will now start by itself, hidden, every time you sign in to Windows.
echo Starting it now as well...
wscript.exe "%~dp0start-hidden.vbs"
echo.
echo Check it at http://127.0.0.1:7777   (log: helper.log in this folder)
echo To undo, run remove-autostart.bat
pause
