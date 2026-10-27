# Lumen: список железа для отчёта о проблеме. Ничего не меняет, только читает.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$out = New-Object System.Collections.Generic.List[string]
function W($s) { $out.Add([string]$s) }

W ('Windows: ' + [Environment]::OSVersion.VersionString)
try { $os = Get-CimInstance Win32_OperatingSystem; W ('Сборка: ' + $os.Caption + ' ' + $os.Version + ' (' + $os.OSArchitecture + ')') } catch { }
try { $ci = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop; W ('Интеллектуальное управление приложениями (0 выкл, 1 вкл, 2 оценка): ' + $ci.VerifiedAndReputablePolicyState) } catch { }
try { $b = Get-CimInstance Win32_BaseBoard; W ('Материнская плата: ' + $b.Manufacturer + ' ' + $b.Product + ' ' + $b.Version) } catch { }
try { $bios = Get-CimInstance Win32_BIOS; W ('BIOS: ' + $bios.Manufacturer + ' ' + $bios.SMBIOSBIOSVersion) } catch { }
try { $cpu = Get-CimInstance Win32_Processor; W ('Процессор: ' + $cpu.Name) } catch { }
W ''
W '--- Видеокарты ---'
try { Get-CimInstance Win32_VideoController | ForEach-Object { W ($_.Name + '  |  драйвер ' + $_.DriverVersion + '  |  ' + $_.PNPDeviceID) } } catch { }
W ''
W '--- Оперативная память ---'
try { Get-CimInstance Win32_PhysicalMemory | ForEach-Object { W ($_.BankLabel + ' ' + $_.DeviceLocator + ': ' + $_.Manufacturer + ' ' + ($_.PartNumber -replace '\s+$', '') + ' ' + [math]::Round($_.Capacity / 1GB) + 'GB ' + $_.ConfiguredClockSpeed + 'MHz') } } catch { }
W ''
W '--- Драйвер PawnIO ---'
try { $p = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO' -ErrorAction Stop; W ('установлен, версия ' + $p.DisplayVersion) } catch { W 'не установлен' }
try { $svc = Get-Service PawnIO -ErrorAction Stop; W ('служба: ' + $svc.Status) } catch { }
W ''
W '--- Устройства Windows «Динамическая подсветка» ---'
try { Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match 'LampArray|Lamp Array' -or $_.Class -eq 'LampArray' } | ForEach-Object { W ($_.FriendlyName + '  |  ' + $_.InstanceId) } } catch { }
W ''
W '--- USB- и HID-устройства (VID:PID) ---'
$seen = @{}
try {
    Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})' } | ForEach-Object {
        $null = $_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})'
        $key = $Matches[1] + ':' + $Matches[2]
        if (-not $seen.ContainsKey($key)) { $seen[$key] = New-Object System.Collections.Generic.List[string] }
        $n = '[' + $_.Class + '] ' + $_.FriendlyName
        if (-not $seen[$key].Contains($n)) { $seen[$key].Add($n) }
    }
} catch { W ('ошибка: ' + $_.Exception.Message) }
foreach ($k in ($seen.Keys | Sort-Object)) { W ($k + '  ' + ($seen[$k] -join '; ')) }
W ''
W '--- Запущенные программы подсветки и мониторинга ---'
$names = 'SignalRgb','iCUE','lghub','ArmouryCrate','LightingService','Aura','MysticLight','MSI.CentralServer','RGBFusion','NZXT','OpenRGB','Synapse','RazerCentral','SteelSeries','L-Connect','Polychrome','HWiNFO','AIDA64','FanControl','Wallpaper'
Get-Process | Where-Object { $p = $_.ProcessName; @($names | Where-Object { $p -like ('*' + $_ + '*') }).Count -gt 0 } | ForEach-Object { W ($_.ProcessName + '  ' + $(try { $_.Path } catch { '' })) } | Select-Object -Unique
W ''
W '--- Задача «Lumen Engine» ---'
try { $t = Get-ScheduledTask -TaskName 'Lumen Engine' -ErrorAction Stop; $i = $t | Get-ScheduledTaskInfo; W ('состояние ' + $t.State + ', последний запуск ' + $i.LastRunTime + ', результат ' + $i.LastTaskResult) } catch { W 'нет' }
$out | ForEach-Object { [Console]::Out.WriteLine($_) }
