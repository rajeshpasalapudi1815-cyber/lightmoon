@echo off
rem Stops our model until Windows next starts (or until "Start our model").
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
