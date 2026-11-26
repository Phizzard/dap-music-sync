@echo off
set "PATH=%APPDATA%\nvm\v22.12.0;%PATH%"
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
