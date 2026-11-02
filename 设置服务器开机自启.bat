@echo off
setlocal

rem �������������ϡ��Ҽ� �� �Թ���Ա�������С���
rem ���ã����ŷ���ǽ�˿� + ע�Ὺ���������������¼���ں�̨���У���
rem ȡ��������schtasks /delete /tn CAN-Replay-Web /f

set "PORT=8000"
set "TASK=CAN-Replay-Web"
set "BACKEND=%~dp0backend"
set "PYEXE=%BACKEND%\.venv\Scripts\python.exe"

net session >nul 2>&1
if errorlevel 1 (
  echo [����] ���Ҽ����ļ���ѡ���Թ���Ա�������С���
  pause
  exit /b 1
)

if not exist "%PYEXE%" (
  echo [����] δ�ҵ����⻷������������ �״ΰ�װ.bat
  pause
  exit /b 1
)

echo [1/3] ���ŷ���ǽ TCP %PORT% ...
netsh advfirewall firewall delete rule name="%TASK%" >nul 2>&1
netsh advfirewall firewall add rule name="%TASK%" dir=in action=allow protocol=TCP localport=%PORT% >nul
if not "%PORT%"=="8000" setx /M CAN_REPLAY_PORT %PORT% >nul

echo [2/3] ע�Ὺ���������� %TASK% ...
schtasks /create /tn "%TASK%" /sc onstart /ru SYSTEM /rl HIGHEST /f ^
  /tr "\"%PYEXE%\" \"%BACKEND%\run_server.py\"" >nul
if errorlevel 1 (
  echo [����] ע������ʧ�ܡ�
  pause
  exit /b 1
)

echo [3/3] ������������ ...
schtasks /end /tn "%TASK%" >nul 2>&1
schtasks /run /tn "%TASK%" >nul

echo.
echo ��ɣ��Եȼ��룬ͬ�¼�������������ʣ�
echo   http://%COMPUTERNAME%:%PORT%/
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%j in ("%%i") do echo   http://%%j:%PORT%/
echo.
echo ����Ŀ¼��%~dp0server-data
pause
