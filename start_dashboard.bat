@echo off
chcp 65001 >nul
echo ============================
echo  BOP Dashboard Local Start
echo ============================

cd /d "%~dp0"

:: .venv Python 우선, 없으면 시스템 Python
if exist ".venv\Scripts\python.exe" (
    set PYTHON=.venv\Scripts\python.exe
) else (
    set PYTHON=python
)

echo [Flask] %PYTHON% app.py (Port 5005)
start "BOP Flask Server" cmd /k "%PYTHON% app.py"

timeout /t 2 /nobreak >nul

echo.
echo Server starting... opening browser in 4 seconds
timeout /t 4 /nobreak >nul

start http://localhost:5005

echo.
echo [OK] Browser opened: http://localhost:5005
echo      Close the "BOP Flask Server" window to stop the server.
pause
