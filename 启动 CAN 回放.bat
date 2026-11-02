@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
if not exist ".venv\Scripts\python.exe" (
  echo [错误] 未找到虚拟环境，请先双击项目根目录的:
  echo   首次安装.bat
  pause
  exit /b 1
)
".venv\Scripts\python.exe" launch.py
pause
