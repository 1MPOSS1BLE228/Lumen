@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Сборка установщика Lumen
echo.
echo  ====================================================
echo    Lumen: сборка установщика для Windows
echo    Всё нужное скачается само. Это займёт 3-10 минут.
echo  ====================================================
echo.

rem --- 1. Node.js ---------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Node.js не найден, устанавливаю. Windows может спросить разрешение: нажми "Да".
  where winget >nul 2>nul
  if not errorlevel 1 (
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  ) else (
    echo winget не найден, скачиваю установщик Node.js с nodejs.org...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$v=(Invoke-RestMethod https://nodejs.org/dist/index.json | Where-Object { $_.lts } | Select-Object -First 1).version; $u='https://nodejs.org/dist/'+$v+'/node-'+$v+'-x64.msi'; Invoke-WebRequest $u -OutFile $env:TEMP\node-lts.msi; Start-Process msiexec -ArgumentList '/i',($env:TEMP+'\node-lts.msi'),'/passive' -Wait"
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Не удалось установить Node.js автоматически.
    echo Скачай его вручную с https://nodejs.org ^(кнопка LTS^), установи и запусти этот файл снова.
    pause
    exit /b 1
  )
) else (
  echo [1/3] Node.js уже установлен.
)

rem --- 2. Зависимости -----------------------------------------------
if not exist "node_modules\electron\package.json" (
  echo [2/3] Скачиваю Electron и инструменты сборки...
  call npm install --save-dev electron electron-builder
  if errorlevel 1 goto :fail
) else (
  echo [2/3] Зависимости уже скачаны.
)

rem --- Движок подсветки ----------------------------------------------
if not exist "vendor\OpenRGB\OpenRGB.exe" (
  echo.
  echo  ВНИМАНИЕ: в папке vendor\OpenRGB нет OpenRGB.exe.
  echo  Lumen соберётся, но будет управлять только устройствами Windows Dynamic Lighting.
  echo  Чтобы работали плата, видеокарта и вентиляторы, распакуй туда OpenRGB ^(см. README.txt в той папке^).
  echo.
  pause
) else (
  echo Движок подсветки OpenRGB найден, будет встроен в установщик.
)

rem --- 3. Сборка ----------------------------------------------------
echo [3/3] Собираю установщик...
call npm run dist
if errorlevel 1 (
  echo Первая попытка не удалась, пробую упрощённую сборку...
  call npm run dist:safe
  if errorlevel 1 goto :fail
)

for %%F in (dist\Lumen-Setup-*.exe) do copy /y "%%F" "%~dp0Lumen-Setup.exe" >nul
if not exist "%~dp0Lumen-Setup.exe" goto :fail

echo.
echo  ====================================================
echo    Готово! Установщик: Lumen-Setup.exe ^(в этой папке^)
echo    Запусти его, и Lumen встанет на компьютер.
echo  ====================================================
explorer /select,"%~dp0Lumen-Setup.exe"
pause
exit /b 0

:fail
echo.
echo Сборка не удалась. Прокрути окно выше и найди строку с "error".
echo Частые причины: нет интернета или антивирус заблокировал загрузку.
pause
exit /b 1
