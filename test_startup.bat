@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
    set PYTHON=.venv\Scripts\python.exe
) else (
    set PYTHON=python
)
echo [Python] %PYTHON%
%PYTHON% --version
echo.
echo [Checking imports...]
%PYTHON% -c "import flask; import supabase; import pandas; print('All imports OK')"
echo.
echo [Checking app.py syntax...]
%PYTHON% -c "import ast; ast.parse(open('app.py', encoding='utf-8').read()); print('app.py syntax OK')"
echo.
echo [Checking port 5005...]
netstat -ano | findstr :5005
echo (empty = port free)
echo.
echo [Starting server - errors will show below...]
echo Press Ctrl+C to stop
echo =========================================
%PYTHON% app.py
pause
