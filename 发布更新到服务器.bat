@echo off
setlocal

rem �����Լ��ĵ��������У������´���ͬ����������������
rem �������˵ķ����⵽����仯���Զ�������ͬ��ˢ����ҳ�����°汾��
rem ��������ַ������ͬĿ¼ publish_target.txt���״�����ʱѯ�ʣ������� \\192.168.1.50\can-replay

set "SRC=%~dp0"
set "CFG=%~dp0publish_target.txt"

if exist "%CFG%" set /p TARGET=<"%CFG%"
if not defined TARGET (
  echo ������������� can-replay Ŀ¼�Ĺ���·�������� \\192.168.1.50\can-replay����
  set /p TARGET=^>
)
if not defined TARGET (
  echo [����] δ����·����
  pause
  exit /b 1
)
if not exist "%TARGET%\backend" (
  echo [����] �޷����� "%TARGET%\backend"
  echo ��ȷ�ϣ��������ѹ��� can-replay Ŀ¼������дȨ�ޣ�����·���Ƿ���ȷ��
  echo �޸�·����ɾ����༭ %CFG%
  pause
  exit /b 1
)
> "%CFG%" echo %TARGET%

echo ������ %TARGET% ...
robocopy "%SRC%backend\static" "%TARGET%\backend\static" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :fail
robocopy "%SRC%backend" "%TARGET%\backend" *.py requirements.txt /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :fail
robocopy "%SRC%samples" "%TARGET%\samples" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%SRC%." "%TARGET%" *.bat README.md /NFL /NDL /NJH /NJS /NP /XF publish_target.txt >nul

echo.
echo ������ɡ��������������Զ�������ͬ��ˢ����ҳ���ɿ������¡�
echo ��ʾ����������޸��� requirements.txt�����������������ڷ���������������һ�� �״ΰ�װ.bat��
pause
exit /b 0

:fail
echo [����] ����ʧ�ܣ����������빲��Ȩ�ޡ�
pause
exit /b 1
