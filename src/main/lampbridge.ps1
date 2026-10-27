# Lumen: мост к встроенной в Windows 11 «Динамической подсветке» (Windows.Devices.Lights.LampArray).
# Запускается приложением Lumen как невидимый процесс и общается с ним строками через stdin/stdout.
#   вход:  {"cmd":"list","id":1}        -> ответ {"id":1,"ok":true,"devices":[...]}
#          S<TAB><номер устройства><TAB><base64 из r,g,b,...>   (кадр цветов, без ответа)
#          {"cmd":"quit"}
# Запуск с ключом -Diag печатает отчёт для проверки.
param([switch]$Diag)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

function Emit($obj) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Enumeration.DeviceInformationCollection, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Lights.LampArray, Windows.Devices.Lights, ContentType = WindowsRuntime]
} catch {
    if ($Diag) { Write-Host ('Не удалось загрузить компоненты Windows: ' + $_.Exception.Message) } else { Emit @{ event = 'fatal'; message = ('Нет доступа к API подсветки Windows: ' + $_.Exception.Message) } }
    exit 2
}

$backtick = [char]96
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + $backtick + '1')
})[0]

function Await($op, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    if (-not $task.Wait(15000)) { throw 'Windows не ответила вовремя' }
    return $task.Result
}

$script:arrays = @()    # открытые LampArray: @{ id; array; count; indices }

function Open-All {
    $selector = [Windows.Devices.Lights.LampArray]::GetDeviceSelector()
    $infos = @(Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection]))
    $known = @{}
    foreach ($a in $script:arrays) { $known[$a.id] = $a }
    $next = @()
    foreach ($info in $infos) {
        if ($known.ContainsKey($info.Id)) { $next += $known[$info.Id]; continue }
        try {
            $arr = Await ([Windows.Devices.Lights.LampArray]::FromIdAsync($info.Id)) ([Windows.Devices.Lights.LampArray])
        } catch { $arr = $null }
        if ($null -eq $arr) { continue }
        $count = [int]$arr.LampCount
        $indices = New-Object 'int[]' $count
        for ($i = 0; $i -lt $count; $i++) { $indices[$i] = $i }
        $next += @{ id = $info.Id; name = $info.Name; array = $arr; count = $count; indices = $indices }
    }
    $script:arrays = $next
}

function Describe-All {
    $out = @()
    for ($n = 0; $n -lt $script:arrays.Count; $n++) {
        $a = $script:arrays[$n]
        $arr = $a.array
        $pos = New-Object 'System.Collections.Generic.List[double]'
        for ($i = 0; $i -lt $a.count; $i++) {
            $p = $arr.GetLampInfo($i).Position
            $pos.Add([double]$p.X); $pos.Add([double]$p.Y); $pos.Add([double]$p.Z)
        }
        $bb = $arr.BoundingBox
        $minMs = 0
        $avail = $true
        try { $avail = [bool]$arr.IsAvailable } catch { }
        try { $minMs = [double]$arr.MinUpdateInterval.TotalMilliseconds } catch { }
        $out += @{
            handle = $n; id = $a.id; name = [string]$a.name; kind = [int]$arr.LampArrayKind; count = $a.count
            connected = [bool]$arr.IsConnected; enabled = [bool]$arr.IsEnabled; available = $avail; minInterval = $minMs
            bbox = @([double]$bb.X, [double]$bb.Y, [double]$bb.Z); pos = $pos.ToArray()
        }
    }
    return , $out
}

# Тип Windows.UI.Color по имени загрузить не удаётся, поэтому берём его из подписи метода SetColor
$script:colorType = $null
$script:colorFields = @{}
function Init-Color {
    if ($null -ne $script:colorType) { return }
    $t = $null
    try { $t = [Windows.Devices.Lights.LampArray].GetMethod('SetColor').GetParameters()[0].ParameterType } catch { }
    if ($null -eq $t) { try { $t = [Type]::GetType('Windows.UI.Color, Windows, ContentType=WindowsRuntime') } catch { } }
    if ($null -eq $t) { throw 'Не удалось найти тип цвета Windows.UI.Color' }
    $fields = @{}
    foreach ($n in 'A', 'R', 'G', 'B') {
        $m = $t.GetField($n)
        if ($null -eq $m) { $m = $t.GetProperty($n) }
        if ($null -eq $m) { throw ('У типа цвета нет поля ' + $n) }
        $fields[$n] = $m
    }
    $script:colorType = $t
    $script:colorFields = $fields
}

function New-Colors([byte[]]$bytes, [int]$n) {
    Init-Color
    $colors = [Array]::CreateInstance($script:colorType, $n)
    $fa = $script:colorFields['A']; $fr = $script:colorFields['R']; $fg = $script:colorFields['G']; $fb = $script:colorFields['B']
    for ($i = 0; $i -lt $n; $i++) {
        $c = [Activator]::CreateInstance($script:colorType)
        $fa.SetValue($c, [byte]255)
        $fr.SetValue($c, [byte]$bytes[$i * 3])
        $fg.SetValue($c, [byte]$bytes[$i * 3 + 1])
        $fb.SetValue($c, [byte]$bytes[$i * 3 + 2])
        $colors.SetValue($c, $i)
    }
    return , $colors
}

function Set-Frame([int]$handle, [string]$b64) {
    $a = $script:arrays[$handle]
    if ($null -eq $a) { return }
    $bytes = [Convert]::FromBase64String($b64)
    $n = [Math]::Min($a.count, [int]($bytes.Length / 3))
    if ($n -le 0) { return }
    $idx = $a.indices
    if ($n -ne $a.count) { $idx = $a.indices[0..($n - 1)] }
    $a.array.SetColorsForIndices((New-Colors $bytes $n), [int[]]$idx)
}

# ---------- Режим проверки ----------
if ($Diag) {
    Write-Host '=== Проверка подсветки Windows (Dynamic Lighting) ==='
    Write-Host ('Windows: ' + [Environment]::OSVersion.VersionString)
    Write-Host ('PowerShell: ' + $PSVersionTable.PSVersion)
    try { Open-All } catch { Write-Host ('ОШИБКА поиска устройств: ' + $_.Exception.Message); exit 3 }
    Write-Host ('Найдено устройств с поддержкой Dynamic Lighting: ' + $script:arrays.Count)
    if ($script:arrays.Count -eq 0) {
        Write-Host 'Ни одно устройство не отозвалось. Проверь: Параметры - Персонализация - Динамическая подсветка - включено ли'
        Write-Host '"Использовать динамическую подсветку на моих устройствах" и видны ли твои устройства в списке.'
        exit 0
    }
    try { Init-Color; Write-Host ('Тип цвета найден: ' + $script:colorType.FullName) } catch { Write-Host ('ОШИБКА типа цвета: ' + $_.Exception.Message) }
    $first = $true
    foreach ($a in $script:arrays) {
        $arr = $a.array
        Write-Host ''
        Write-Host ('Устройство: ' + $a.name)
        Write-Host ('  ламп: ' + $a.count + ', тип: ' + $arr.LampArrayKind + ', подключено: ' + $arr.IsConnected + ', включено: ' + $arr.IsEnabled)
        $av = '?'; try { $av = $arr.IsAvailable } catch { }
        Write-Host ('  Windows разрешает управлять (IsAvailable): ' + $av)
        if ($av -eq $false) { Write-Host '  -> Управление сейчас у другой программы (SignalRGB, G HUB и т.п.) или у приложения с приоритетом в параметрах Windows.' }
        $bb = $arr.BoundingBox
        Write-Host ('  размер, м: ' + $bb.X + ' x ' + $bb.Y + ' x ' + $bb.Z)
        if ($first) {
            Write-Host '  свойства и методы LampArray в этой версии Windows:'
            Write-Host ('    ' + (($arr | Get-Member | ForEach-Object { $_.Name }) -join ', '))
            $first = $false
        }
        if ($a.count -gt 0) { $p = $arr.GetLampInfo(0).Position; Write-Host ('  первая лампа: x=' + $p.X + ' y=' + $p.Y + ' z=' + $p.Z) }
    }
    Write-Host ''
    foreach ($color in @(@(255, 0, 0, 'красный'), @(0, 255, 0, 'зелёный'), @(0, 0, 255, 'синий'))) {
        Write-Host ('Включаю ' + $color[3] + ' на 2 секунды на всех устройствах...')
        for ($h = 0; $h -lt $script:arrays.Count; $h++) {
            try {
                $n = $script:arrays[$h].count
                $bytes = New-Object 'byte[]' ($n * 3)
                for ($i = 0; $i -lt $n; $i++) { $bytes[$i * 3] = $color[0]; $bytes[$i * 3 + 1] = $color[1]; $bytes[$i * 3 + 2] = $color[2] }
                Set-Frame $h ([Convert]::ToBase64String($bytes))
            } catch { Write-Host ('  ОШИБКА на устройстве ' + $script:arrays[$h].name + ': ' + $_.Exception.Message) }
        }
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    Write-Host 'Готово. Если цвета на устройствах менялись, встроенное управление работает.'
    Write-Host 'Если ошибок нет, а цвета не менялись: Параметры - Персонализация - Динамическая подсветка - Фоновое управление подсветкой.'
    exit 0
}

# ---------- Рабочий режим ----------
Emit @{ event = 'ready' }
:main while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Length -eq 0) { continue }
    if ($line[0] -eq 'S') {
        try {
            $parts = $line.Split("`t")
            Set-Frame ([int]$parts[1]) $parts[2]
        } catch {
            Emit @{ event = 'error'; message = $_.Exception.Message }
        }
        continue
    }
    $msg = $null
    try {
        $msg = $line | ConvertFrom-Json
        switch ($msg.cmd) {
            'list' {
                Open-All
                Emit @{ id = $msg.id; ok = $true; devices = (Describe-All) }
            }
            'quit' { break main }
        }
    } catch {
        $rid = $null
        if ($null -ne $msg) { $rid = $msg.id }
        Emit @{ id = $rid; ok = $false; error = $_.Exception.Message }
    }
}
