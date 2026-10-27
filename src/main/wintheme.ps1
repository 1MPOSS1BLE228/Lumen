# Lumen: цвет оформления Windows (акцентный цвет, тёмная/светлая тема). Меняет только настройки текущего пользователя (HKCU).
#   -Action Read                       печатает текущие значения в JSON (для резервной копии)
#   -Action Apply -Accent RRGGBB [-Dark 0|1]   ставит акцентный цвет (и тему, если указан -Dark)
#   -Action Restore -Backup <base64 JSON из Read>   возвращает значения из резервной копии
param(
    [Parameter(Mandatory = $true)][ValidateSet('Read', 'Apply', 'Restore')][string]$Action,
    [string]$Accent = '',
    [int]$Dark = -1,
    [string]$Backup = ''
)
$ErrorActionPreference = 'Stop'

$dwm = 'HKCU:\Software\Microsoft\Windows\DWM'
$acc = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$per = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$desk = 'HKCU:\Control Panel\Desktop'

# ключ реестра, имя значения, как называется в резервной копии
$items = @(
    @($dwm, 'AccentColor', 'dwmAccent'), @($dwm, 'ColorizationColor', 'dwmColorization'),
    @($dwm, 'ColorizationAfterglow', 'dwmAfterglow'), @($dwm, 'ColorPrevalence', 'dwmPrevalence'),
    @($acc, 'AccentColorMenu', 'accentMenu'), @($acc, 'StartColorMenu', 'startMenu'), @($acc, 'AccentPalette', 'palette'),
    @($per, 'ColorPrevalence', 'perPrevalence'), @($per, 'AppsUseLightTheme', 'appsLight'), @($per, 'SystemUsesLightTheme', 'systemLight'),
    @($desk, 'AutoColorization', 'autoColor')
)

function Get-Val($path, $name) {
    try {
        $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name
        if ($v -is [byte[]]) { return ([BitConverter]::ToString($v) -replace '-', '') }
        return [int64]$v
    } catch { return $null }
}

function To-Int32([uint32]$u) { return [BitConverter]::ToInt32([BitConverter]::GetBytes($u), 0) }

function Set-Dword($path, $name, [uint32]$value) {
    if (-not (Test-Path $path)) { $null = New-Item -Path $path -Force }
    Set-ItemProperty -Path $path -Name $name -Type DWord -Value (To-Int32 $value)
}

function Broadcast {
    Add-Type -Namespace Lumen -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    $r = [UIntPtr]::Zero
    # Проводник перечитывает цвет не сразу: на первое уведомление он часто берёт старое значение
    # (цвет «отставал» на одну тему). Поэтому шлём уведомление ещё раз после паузы.
    $null = [Lumen.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 3000, [ref]$r)
    Start-Sleep -Milliseconds 700
    $null = [Lumen.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 3000, [ref]$r)
    $null = [Lumen.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'WindowsThemeElement', 2, 3000, [ref]$r)
}

function Set-Immersive([int]$r, [int]$g, [int]$b, [int[]]$dark) {
    # Тот же вызов, которым цвет меняют «Параметры» Windows: uxtheme.dll, ordinal 120/122.
    # Без него Проводник подхватывает новый цвет только со следующей сменой.
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LumenUx {
  [StructLayout(LayoutKind.Sequential)] public struct Pref { public uint Color1; public uint Color2; }
  public static class Ux {
    [DllImport("uxtheme.dll", EntryPoint = "#120")] public static extern int GetUserColorPreference(ref Pref p, bool forceReload);
    [DllImport("uxtheme.dll", EntryPoint = "#122")] public static extern int SetUserColorPreference(ref Pref p, bool forceCommit);
  }
}
'@ -ErrorAction SilentlyContinue
        $p = New-Object LumenUx.Pref
        $hr = [LumenUx.Ux]::GetUserColorPreference([ref]$p, $true)
        $p.Color1 = [uint32](($dark[2] -shl 16) -bor ($dark[1] -shl 8) -bor $dark[0])   # фон «Пуска», формат 0x00BBGGRR
        $p.Color2 = [uint32](($b -shl 16) -bor ($g -shl 8) -bor $r)                      # акцент
        $hr2 = [LumenUx.Ux]::SetUserColorPreference([ref]$p, $true)
        return ('get=' + $hr + ' set=' + $hr2)
    } catch { return ('immersive-error: ' + $_.Exception.Message) }
}

function Shade([int[]]$c, [double]$toward, [double]$k) {
    # k = 0..1 доля смешивания с белым (toward=255) или чёрным (toward=0)
    return @(0, 1, 2 | ForEach-Object { [int][Math]::Round($c[$_] + ($toward - $c[$_]) * $k) })
}

switch ($Action) {
    'Read' {
        $o = [ordered]@{}
        foreach ($it in $items) { $o[$it[2]] = Get-Val $it[0] $it[1] }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
    }
    'Apply' {
        if ($Accent -notmatch '^[0-9a-fA-F]{6}$') { throw 'Цвет должен быть в формате RRGGBB' }
        $r = [Convert]::ToInt32($Accent.Substring(0, 2), 16)
        $g = [Convert]::ToInt32($Accent.Substring(2, 2), 16)
        $b = [Convert]::ToInt32($Accent.Substring(4, 2), 16)
        $abgr = [uint32]([int64]4278190080 -bor ($b -shl 16) -bor ($g -shl 8) -bor $r)
        $argb = [uint32]([int64]3288334336 -bor ($r -shl 16) -bor ($g -shl 8) -bor $b)

        # Автоподбор цвета по обоям мешал бы нам
        Set-ItemProperty -Path $desk -Name 'AutoColorization' -Value '0' -Type String
        $base = @($r, $g, $b)
        $shades = @((Shade $base 255 0.6), (Shade $base 255 0.4), (Shade $base 255 0.2), $base,
                    (Shade $base 0 0.28), (Shade $base 0 0.5), (Shade $base 0 0.66), (Shade $base 0 0.66))
        # Сначала — системный вызов, пока в реестре ещё старый цвет. Если записать реестр раньше,
        # Windows считает, что цвет не изменился, и панель задач остаётся с прошлым цветом.
        $imm = Set-Immersive $r $g $b $shades[5]
        Start-Sleep -Milliseconds 300
        Set-Dword $dwm 'AccentColor' $abgr
        Set-Dword $dwm 'ColorizationColor' $argb
        Set-Dword $dwm 'ColorizationAfterglow' $argb
        Set-Dword $dwm 'ColorPrevalence' 1
        if (-not (Test-Path $acc)) { $null = New-Item -Path $acc -Force }
        Set-Dword $acc 'AccentColorMenu' $abgr
        Set-Dword $acc 'StartColorMenu' $abgr

        # Палитра из 8 оттенков: три светлее, основной цвет, четыре темнее (формат R,G,B,0 на каждый)
        $bytes = New-Object 'byte[]' 32
        for ($i = 0; $i -lt 8; $i++) { for ($j = 0; $j -lt 3; $j++) { $bytes[$i * 4 + $j] = [byte]$shades[$i][$j] }; $bytes[$i * 4 + 3] = 0 }
        Set-ItemProperty -Path $acc -Name 'AccentPalette' -Type Binary -Value $bytes

        if ($Dark -ge 0) {
            $light = 1 - [Math]::Min(1, $Dark)
            Set-Dword $per 'AppsUseLightTheme' $light
            Set-Dword $per 'SystemUsesLightTheme' $light
        }
        # Показывать цвет на панели задач и в «Пуске» (работает в тёмной теме)
        $sysLight = Get-Val $per 'SystemUsesLightTheme'
        if ($sysLight -eq 0) { Set-Dword $per 'ColorPrevalence' 1 }
        Broadcast
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; immersive = $imm } -Compress))
    }
    'Restore' {
        if (-not $Backup) { throw 'Нет резервной копии' }
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Backup)) | ConvertFrom-Json
        foreach ($it in $items) {
            $v = $json.($it[2])
            if ($null -eq $v) { continue }
            if ($it[1] -eq 'AccentPalette') {
                $hex = [string]$v
                $bytes = New-Object 'byte[]' ($hex.Length / 2)
                for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
                Set-ItemProperty -Path $it[0] -Name $it[1] -Type Binary -Value $bytes
            } elseif ($it[1] -eq 'AutoColorization') {
                Set-ItemProperty -Path $it[0] -Name $it[1] -Value ([string]$v) -Type String
            } else {
                Set-Dword $it[0] $it[1] ([uint32]([int64]$v -band 4294967295))
            }
        }
        Broadcast
        [Console]::Out.WriteLine('{"ok":true}')
    }
}
