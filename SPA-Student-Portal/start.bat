@echo off
title Saint Patrick's Academy - Portal Server
cd /d "%~dp0"
echo Starting the portal server...
echo.
echo   Portal : http://localhost:3000/
echo   Admin  : http://localhost:3000/admin.html
echo.
echo Keep this window open while using the site.
echo Press Ctrl+C to stop the server.
echo.
rem Find Node.js. It is often installed without being on the PATH, so check
rem the usual install folders before giving up.
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"

if not defined NODE_EXE (
  echo ERROR: Node.js was not found on this computer.
  echo.
  echo Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

"%NODE_EXE%" server.js
echo.
echo The server has stopped.
pause
