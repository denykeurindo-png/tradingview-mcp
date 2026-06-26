@echo off
REM Launch isolated debug Chrome session for Cockpit Dashboard
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_cockpit_debug.ps1"
