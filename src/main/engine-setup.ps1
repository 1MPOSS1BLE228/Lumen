# Lumen: включение подсветки оперативной памяти. Запускается ОДИН раз с правами администратора (окно Windows «Разрешить?»).
#  1. Ставит драйвер PawnIO (официальный установщик, тихо) — через него движок видит память и часть плат.
#  2. Копирует движок в Program Files\Lumen Engine (туда может писать только администратор).
#  3. Создаёт задачу планировщика «Lumen Engine», которая запускает движок с правами администратора без вопросов.
param([string]$Source, [string]$PawnIO, [string]$RunScript, [string]$User, [string]$Result)
$ErrorActionPreference = 'Stop'
$out = [ordered]@{ ok = $false; pawnio = ''; message = '' }
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO'
try {
    if (Test-Path $key) { $out.pawnio = 'present' }
    else {
        if (-not (Test-Path -LiteralPath $PawnIO)) { throw 'Не найден установщик PawnIO' }
        $pr = Start-Process -FilePath $PawnIO -ArgumentList @('-install', '-silent') -Wait -PassThru
        if (Test-Path $key) { $out.pawnio = 'installed' } else { throw ('Драйвер PawnIO не установился (код ' + $pr.ExitCode + ')') }
    }
    $dest = Join-Path $env:ProgramFiles 'Lumen Engine'
    $null = New-Item -ItemType Directory -Force -Path $dest
    Get-Process OpenRGB -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($dest + '*') } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $null = & robocopy.exe $Source (Join-Path $dest 'OpenRGB') /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw ('Не удалось скопировать движок (код ' + $LASTEXITCODE + ')') }
    Copy-Item -LiteralPath $RunScript -Destination (Join-Path $dest 'engine-run.ps1') -Force
    $run = Join-Path $dest 'engine-run.ps1'
    # conhost --headless — чтобы при запуске не мелькало чёрное окно
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $run + '"')
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $null = Register-ScheduledTask -TaskName 'Lumen Engine' -Action $action -Principal $principal -Settings $settings -Force
    $out.ok = $true
} catch { $out.message = $_.Exception.Message }
[IO.File]::WriteAllText($Result, (ConvertTo-Json -InputObject $out -Compress), (New-Object Text.UTF8Encoding $false))
