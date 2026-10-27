@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Проверка подсветки Windows
echo.
echo  Проверка встроенной подсветки Windows (Dynamic Lighting).
echo  Скрипт найдёт устройства и по очереди включит на них красный, зелёный и синий (по 2 секунды).
echo  Закрой Lumen и другие программы подсветки перед проверкой.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('src\main\lampbridge.ps1',[Text.Encoding]::UTF8); $f=Join-Path $env:TEMP 'lumen-diag.ps1'; [IO.File]::WriteAllText($f,$t,(New-Object Text.UTF8Encoding $true)); & $f -Diag *>&1 | Out-String -Stream | Tee-Object -Variable lines; Set-Content -LiteralPath 'lumen-diagnostic.txt' -Value $lines -Encoding UTF8"
echo.
echo  Отчёт сохранён в файле lumen-diagnostic.txt в этой папке.
pause
