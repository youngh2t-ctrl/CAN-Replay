# 在 can-replay 目录下运行：同时启动后端与前端（需已安装依赖）
$root = $PSScriptRoot

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$root\backend'; if (Test-Path .venv) { .\.venv\Scripts\Activate.ps1 }; pip install -q -r requirements.txt; uvicorn main:app --reload --host 127.0.0.1 --port 8000"
)

Start-Sleep -Seconds 2

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$root\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
)

Write-Host "后端: http://127.0.0.1:8000"
Write-Host "前端: http://localhost:5173"
