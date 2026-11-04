@echo off
rem Запуск без Docker: http://127.0.0.1:8899  (дані — у папці data поруч)
cd /d "%~dp0"
python -m hotmailhub serve --host 127.0.0.1 --port 8899
pause
