@echo off
cd /d "%~dp0backend"
if not exist ".venv\Scripts\python.exe" (
  echo [����] δ�ҵ����⻷��������˫����Ŀ��Ŀ¼��:
  echo   �״ΰ�װ.bat
  pause
  exit /b 1
)
".venv\Scripts\python.exe" run_server.py
pause
