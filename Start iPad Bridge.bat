@echo off
rem Starts the simulator + bridge so phones/iPads on the same Wi-Fi can use the app.
rem The address and PIN to type on the iPad are printed below.
cd /d "%~dp0"
python run.py --lan %*
pause
