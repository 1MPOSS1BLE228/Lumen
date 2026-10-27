# Lumen: обои рабочего стола (только для текущего пользователя).
#   -Action Read                          JSON: текущий путь к обоям, стиль, плитка
#   -Action Set -Path <png>               поставить обои (стиль «Заполнение»)
#   -Action Restore -Path <file> -Style <s> -Tile <t>   вернуть прежние обои
param(
    [Parameter(Mandatory = $true)][ValidateSet('Read', 'Set', 'Restore')][string]$Action,
    [string]$Path = '',
    [string]$Style = '10',
    [string]$Tile = '0',
    [int]$Jpeg = -1
)
$ErrorActionPreference = 'Stop'
$desk = 'HKCU:\Control Panel\Desktop'

function Get-Str($name) {
    try { return [string](Get-ItemProperty -Path $desk -Name $name -ErrorAction Stop).$name } catch { return '' }
}

function Apply-Wallpaper([string]$file) {
    Add-Type -Namespace LumenWp -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
'@
    # 20 = SPI_SETDESKWALLPAPER, 3 = записать в профиль и разослать изменение
    if (-not [LumenWp.Native]::SystemParametersInfo(20, 0, $file, 3)) { throw 'Windows не приняла обои' }
}

switch ($Action) {
    'Read' {
        $transcoded = Join-Path $env:APPDATA 'Microsoft\Windows\Themes\TranscodedWallpaper'
        $o = [ordered]@{
            path = Get-Str 'WallPaper'; style = Get-Str 'WallpaperStyle'; tile = Get-Str 'TileWallpaper'
            jpeg = $(try { [int](Get-ItemProperty -Path $desk -Name 'JPEGImportQuality' -ErrorAction Stop).JPEGImportQuality } catch { -1 })
            transcoded = $(if (Test-Path $transcoded) { $transcoded } else { '' })
        }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
    }
    'Set' {
        if (-not (Test-Path $Path)) { throw 'Файл обоев не найден' }
        Set-ItemProperty -Path $desk -Name 'WallpaperStyle' -Value '10'
        Set-ItemProperty -Path $desk -Name 'TileWallpaper' -Value '0'
        # Без этого Windows пережимает обои в JPEG ~85% и плавные переходы мылятся
        Set-ItemProperty -Path $desk -Name 'JPEGImportQuality' -Type DWord -Value 100
        Apply-Wallpaper $Path
        [Console]::Out.WriteLine('{"ok":true}')
    }
    'Restore' {
        if ($Style) { Set-ItemProperty -Path $desk -Name 'WallpaperStyle' -Value $Style }
        if ($Tile) { Set-ItemProperty -Path $desk -Name 'TileWallpaper' -Value $Tile }
        if ($Jpeg -ge 0) { Set-ItemProperty -Path $desk -Name 'JPEGImportQuality' -Type DWord -Value $Jpeg }
        elseif ($Jpeg -eq -1) { Remove-ItemProperty -Path $desk -Name 'JPEGImportQuality' -ErrorAction SilentlyContinue }
        Apply-Wallpaper $Path
        [Console]::Out.WriteLine('{"ok":true}')
    }
}
