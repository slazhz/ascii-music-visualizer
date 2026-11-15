@echo off
title ACV helper - stop starting automatically
cd /d "%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ACV helper.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Removed: the helper will no longer start with Windows.
) else (
  echo Auto-start was not set up.
)
if not exist "data\helper.pid" goto done
rem Stop the running helper, but only if that process really is this helper.
powershell -NoProfile -Command "$id = [int](Get-Content 'data\helper.pid'); $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*server.js*') { Stop-Process -Id $id; 'Stopped the running helper.' }"
del "data\helper.pid" >nul 2>nul
:done
pause
