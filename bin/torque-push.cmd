@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0torque-push-shim.ps1" %*
exit /b %ERRORLEVEL%
