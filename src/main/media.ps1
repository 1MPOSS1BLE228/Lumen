# Lumen: что сейчас играет (Spotify, Яндекс Музыка, браузер — всё, что показывает Windows в регуляторе громкости).
# Работает постоянно, пока включены «Цвета под музыку». Команды построчно (stdin), ответ — одна строка JSON:
#   poll <ключ прошлого трека>   -> {"ok":true,"playing":true,"app":"...","key":"...","img":"<base64 или пусто, если трек тот же>","pos":мс,"dur":мс}
#   ctl play|next|prev          -> {"ok":true} — пауза/продолжить, следующий, предыдущий трек
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $t.Wait(4000)) { throw 'timeout' }
    return $t.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Poll([string]$lastKey) {
    $s = $mgr.GetCurrentSession()
    if ($null -eq $s) { return @{ ok = $true; playing = $false } }
    $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $key = ('' + $s.SourceAppUserModelId + '|' + $p.Artist + '|' + $p.Title + '|' + $p.AlbumTitle) -replace '[\r\n]', ' '
    $img = ''
    if ($key -ne $lastKey -and $null -ne $p.Thumbnail) {
        $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = [uint32][Math]::Min($st.Size, 4MB)
        if ($size -gt 0) {
            $r = [Windows.Storage.Streams.DataReader]::new($st)
            $null = Await ($r.LoadAsync($size)) ([uint32])
            $bytes = New-Object byte[] $size
            $r.ReadBytes($bytes)
            $img = [Convert]::ToBase64String($bytes)
            $r.Dispose()
        }
        $st.Dispose()
    }
    # где мы в треке: позиция на момент последнего обновления + сколько прошло с тех пор
    $pos = 0; $dur = 0
    try {
        $tl = $s.GetTimelineProperties()
        $dur = [int64]$tl.EndTime.TotalMilliseconds
        $pos = [int64]$tl.Position.TotalMilliseconds
        if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) { $pos += [int64]([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds }
        if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
    } catch { }
    return @{ ok = $true; playing = $playing; app = '' + $s.SourceAppUserModelId; key = $key; img = $img; title = '' + $p.Title; artist = '' + $p.Artist; pos = $pos; dur = $dur }
}

function Control([string]$what) {
    $s = $mgr.GetCurrentSession()
    if ($null -eq $s) { return @{ ok = $false; error = 'сейчас ничего не играет' } }
    $op = switch ($what) { 'next' { $s.TrySkipNextAsync() } 'prev' { $s.TrySkipPreviousAsync() } default { $s.TryTogglePlayPauseAsync() } }
    $done = Await $op ([bool])
    return @{ ok = [bool]$done }
}

[Console]::Out.WriteLine('ready')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq 'quit') { break }
    $last = ''
    if ($line.StartsWith('ctl ')) {
        try { $o = Control $line.Substring(4).Trim() } catch { $o = @{ ok = $false; error = $_.Exception.Message } }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
        continue
    }
    if ($line.StartsWith('poll ')) { $last = $line.Substring(5) }
    try { $o = Poll $last } catch { $o = @{ ok = $false; error = $_.Exception.Message } }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
}
