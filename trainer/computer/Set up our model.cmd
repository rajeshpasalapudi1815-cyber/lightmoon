@echo off
rem Sets up our model on this computer, in %USERPROFILE%\LightMoon\own-model. It asks before downloading anything.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
