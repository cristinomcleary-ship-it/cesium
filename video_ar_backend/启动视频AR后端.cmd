@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] 尚未创建 Python 虚拟环境。
  echo 请先在当前目录执行：py -3.12 -m venv .venv
  echo 然后执行：.venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 2
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [ERROR] 已生成 .env，请先填写设备 SN、MQTT 和 RTMP 参数。
  pause
  exit /b 2
)

".venv\Scripts\python.exe" start.py --check
if errorlevel 1 (
  pause
  exit /b 2
)

".venv\Scripts\python.exe" start.py
if errorlevel 1 pause
