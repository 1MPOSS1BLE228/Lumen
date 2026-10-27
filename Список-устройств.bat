@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lumen: список устройств
echo  Собираю список железа (ничего не меняется, только чтение)...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\inventory.ps1"
echo.
echo  Готово. Список сохранён в lumen-devices.txt в этой папке.
pause
