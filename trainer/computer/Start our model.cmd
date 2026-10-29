@echo off
rem Starts (or restarts) our model in the background, with the newest model in the models folder.
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Tell
