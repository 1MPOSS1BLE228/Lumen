# Lumen: запуск движка подсветки с правами администратора (нужно для оперативной памяти через драйвер PawnIO).
# Запускается задачей планировщика «Lumen Engine», лежит в Program Files (изменить может только администратор).
# Живёт, пока открыт Lumen: как только Lumen закрылся или попросил остановиться — закрывает движок.
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'OpenRGB\OpenRGB.exe'
$data = Join-Path $env:APPDATA 'Lumen'
$req = Join-Path $data 'engine-request.json'
$stop = Join-Path $data 'engine-stop'
$lumen = 0; $port = 6742
try {
    $j = Get-Content -LiteralPath $req -Raw | ConvertFrom-Json
    $lumen = [int]$j.pid
    $port = [int]$j.port
} catch { }
if ($port -lt 1 -or $port -gt 65535) { $port = 6742 }
Remove-Item -LiteralPath $stop -ErrorAction SilentlyContinue
Get-Process OpenRGB -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList @('--server', '--server-port', "$port") -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru
while ($true) {
    Start-Sleep -Milliseconds 1000
    if ($p.HasExited) { break }
    if (Test-Path -LiteralPath $stop) { break }
    if ($lumen -gt 0 -and -not (Get-Process -Id $lumen -ErrorAction SilentlyContinue)) { break }
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $stop -ErrorAction SilentlyContinue
