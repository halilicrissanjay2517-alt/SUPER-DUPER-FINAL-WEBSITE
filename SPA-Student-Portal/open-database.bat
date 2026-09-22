@echo off
title Open the Student Database (database.xlsx)
cd /d "%~dp0"

if not exist "database.xlsx" (
  echo The database file was not found.
  echo.
  echo Start the server first by double-clicking start.bat --
  echo that creates database.xlsx automatically.
  echo.
  pause
  exit /b 1
)

echo Opening the student database in Excel...
echo.
echo   Sheet "Students"  - names, grades, sections, STATUS and BALANCE
echo   Sheet "Admins"    - login accounts
echo   Sheet "Logs"      - who changed what
echo.
echo IMPORTANT: if you edit it by hand, save the file,
echo then close this window and restart start.bat so the
echo website picks up your changes.
echo.
start "" "database.xlsx"
timeout /t 6 >nul
