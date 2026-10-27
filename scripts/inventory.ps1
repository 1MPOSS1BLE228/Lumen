# Lumen: список железа для подбора драйверов подсветки. Ничего не меняет, только читает.
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
function W($s) { $out.Add([string]$s) }

W '=== Lumen: список устройств ==='
W ('Windows: ' + [Environment]::OSVersion.VersionString)
try { $b = Get-CimInstance Win32_BaseBoard; W ('Материнская плата: ' + $b.Manufacturer + ' ' + $b.Product) } catch { W 'Материнская плата: ?' }
W ''
W '--- Видеокарты ---'
try { Get-CimInstance Win32_VideoController | ForEach-Object { W ($_.Name + '  |  ' + $_.PNPDeviceID) } } catch { }
W ''
W '--- Оперативная память ---'
try { Get-CimInstance Win32_PhysicalMemory | ForEach-Object { W ($_.Manufacturer + ' ' + ($_.PartNumber -replace '\s+$', '') + ' ' + [math]::Round($_.Capacity / 1GB) + 'GB') } } catch { }
W ''
W '--- USB-устройства (VID/PID) ---'
$seen = @{}
try {
    Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})' } | ForEach-Object {
        $_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})' | Out-Null
        $key = $Matches[1] + ':' + $Matches[2]
        if (-not $seen.ContainsKey($key)) { $seen[$key] = New-Object System.Collections.Generic.List[string] }
        $n = '[' + $_.Class + '] ' + $_.FriendlyName
        if (-not $seen[$key].Contains($n)) { $seen[$key].Add($n) }
    }
} catch { W ('ошибка: ' + $_.Exception.Message) }
foreach ($k in ($seen.Keys | Sort-Object)) { W ($k + '  ' + ($seen[$k] -join '; ')) }
W ''
W '--- Программы подсветки, которые запущены ---'
$names = 'SignalRgb','SignalRGB','iCUE','lghub','LGHUB','ArmouryCrate','LightingService','MysticLight','RGBFusion','NZXT CAM','OpenRGB','Synapse','RazerCentral','SteelSeriesGG','L-Connect'
Get-Process | Where-Object { $p = $_.ProcessName; @($names | Where-Object { $p -like ('*' + $_ + '*') }).Count -gt 0 } | Select-Object -ExpandProperty ProcessName -Unique | ForEach-Object { W $_ }

$out | ForEach-Object { Write-Host $_ }
Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'lumen-devices.txt') -Value $out -Encoding UTF8
