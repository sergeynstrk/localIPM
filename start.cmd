@echo off
chcp 65001 >nul
echo ========================================================
echo   LocalPM (v2.1) - Локальный планировщик проектов
echo ========================================================
echo Запуск локального статического веб-сервера без установки...
echo Откройте в браузере: http://localhost:8000
echo.

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start http://localhost:8000
    python -m http.server 8000
    goto end
)

where python3 >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start http://localhost:8000
    python3 -m http.server 8000
    goto end
)

echo Python не обнаружен в системе. Открываем index.html напрямую...
start index.html

:end
