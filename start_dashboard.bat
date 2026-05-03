@echo off
echo Starting BOP Dashboard Servers...

:: Start Flask server in a new window
start "Flask Backend (Port 5001)" cmd /c "python app.py"

:: Start Streamlit server in a new window
cd "Project Schedule"
start "Simulation Board (Port 8501)" cmd /c "streamlit run app.py --server.port 8501"
cd ..

echo Both servers are starting up...
echo Please wait a few seconds and then open your browser to:
echo http://localhost:5001
pause
