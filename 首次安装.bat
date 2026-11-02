@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0backend"

echo ========================================
echo   CAN 报文离线回放 — 首次安装
echo ========================================
echo.

set "PY="
where python >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%i in ('python -c "import sys; print(sys.version_info >= (3, 10))" 2^>nul') do set "PY_OK=%%i"
  if "!PY_OK!"=="True" set "PY=python"
)
if not defined PY (
  where py >nul 2>&1
  if %errorlevel%==0 (
    for /f "delims=" %%i in ('py -3 -c "import sys; print(sys.version_info >= (3, 10))" 2^>nul') do set "PY_OK=%%i"
    if "!PY_OK!"=="True" set "PY=py -3"
  )
)
if not defined PY (
  echo [错误] 未找到 Python 3.10 或更高版本。
  echo.
  echo 请先安装 Python：https://www.python.org/downloads/
  echo 安装时务必勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

echo 使用 Python: %PY%
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [1/2] 创建虚拟环境...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo [错误] 创建虚拟环境失败。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 虚拟环境已存在，跳过创建。
)

echo [2/2] 安装依赖（首次可能需要几分钟）...
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)

echo.
echo ========================================
echo   安装完成！
echo ========================================
echo.
echo 下一步：双击项目根目录的「启动 CAN 回放.bat」即可使用。
echo.
pause
exit /b 0
