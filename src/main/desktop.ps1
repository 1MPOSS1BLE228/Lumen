# Lumen: помощник для «живых обоев». Работает всё время, пока включены живые обои,
# и принимает команды построчно (stdin), отвечая одной строкой (stdout):
#   attach <hwnd> <x> <y> <w> <h>   спрятать окно за значки рабочего стола (координаты экрана в пикселях)
#   place  <hwnd> <x> <y> <w> <h>   поправить положение и порядок (после показа окна)
#   check  <hwnd>                   ok — окно на месте; lost — Проводник перезапускался
#   cover                           1 — рабочий стол закрыт игрой или развёрнутым окном, иначе 0
#   net                             счётчики сети по адаптерам: id:принято:отправлено;…
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Net.NetworkInformation;
public static class LumenDesk {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string c, string n);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, IntPtr l, uint f, uint t, out UIntPtr r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);

  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  // Куда вешать окно. raised — новая схема Windows 11 24H2+: значки остаются в Progman,
  // а слой обоев — дочерний WorkerW внутри Progman. classic — старая схема: отдельный WorkerW за значками.
  static IntPtr Target(out IntPtr after, out string mode) {
    after = IntPtr.Zero; mode = "";
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) { mode = "fail:нет Progman"; return IntPtr.Zero; }
    UIntPtr r;
    // Просим Проводник отделить слой обоев от значков (так делают все программы живых обоев)
    SendMessageTimeout(progman, 0x052C, new UIntPtr(0xD), new IntPtr(1), 0, 1000, out r);
    SendMessageTimeout(progman, 0x052C, UIntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (defView != IntPtr.Zero) {
      for (int i = 0; i < 20 && FindWindowEx(progman, IntPtr.Zero, "WorkerW", null) == IntPtr.Zero; i++) System.Threading.Thread.Sleep(100);
      after = defView; mode = "raised";
      return progman;
    }
    IntPtr found = IntPtr.Zero;
    for (int i = 0; i < 20 && found == IntPtr.Zero; i++) {
      EnumWindows((top, l) => {
        if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) found = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
        return true;
      }, IntPtr.Zero);
      if (found == IntPtr.Zero) System.Threading.Thread.Sleep(100);
    }
    if (found == IntPtr.Zero) { mode = "fail:нет слоя обоев"; return IntPtr.Zero; }
    mode = "classic";
    return found;
  }

  public static string Attach(long h, int x, int y, int w, int hh) {
    IntPtr hwnd = new IntPtr(h);
    if (!IsWindow(hwnd)) return "fail:окна нет";
    IntPtr after; string mode;
    IntPtr parent = Target(out after, out mode);
    if (parent == IntPtr.Zero) return mode;
    long style = GetLong(hwnd, -16).ToInt64();
    // убираем рамку и «всплывающий» стиль, делаем дочерним окном
    style = (style & ~0x80000000L & ~0x00C00000L & ~0x00040000L & ~0x00020000L & ~0x00010000L) | 0x40000000L;
    SetLong(hwnd, -16, new IntPtr(style));
    long ex = GetLong(hwnd, -20).ToInt64();
    ex = (ex & ~0x00040000L) | 0x08000000L | 0x00000080L; // без кнопки на панели задач, не берёт фокус
    if (mode == "raised") ex |= 0x00080000L; // в новой схеме дочернее окно должно быть «слоёным»
    SetLong(hwnd, -20, new IntPtr(ex));
    if (mode == "raised") SetLayeredWindowAttributes(hwnd, 0, 255, 2);
    SetParent(hwnd, parent);
    Place(hwnd, parent, after, mode, x, y, w, hh);
    return mode;
  }

  static void Place(IntPtr hwnd, IntPtr parent, IntPtr after, string mode, int x, int y, int w, int hh) {
    RECT pr; GetWindowRect(parent, out pr);
    uint flags = 0x0010 | 0x0020; // NOACTIVATE, FRAMECHANGED
    if (mode != "raised") flags |= 0x0004; // NOZORDER
    SetWindowPos(hwnd, after, x - pr.L, y - pr.T, w, hh, flags);
  }

  public static string Replace(long h, int x, int y, int w, int hh) {
    IntPtr hwnd = new IntPtr(h);
    IntPtr parent = GetParent(hwnd);
    if (!IsWindow(hwnd) || parent == IntPtr.Zero) return "lost";
    string c = Cls(parent);
    IntPtr after = IntPtr.Zero;
    string mode = "classic";
    if (c == "Progman") { after = FindWindowEx(parent, IntPtr.Zero, "SHELLDLL_DefView", null); mode = "raised"; }
    Place(hwnd, parent, after, mode, x, y, w, hh);
    return "ok";
  }

  public static string Check(long h) {
    IntPtr hwnd = new IntPtr(h);
    if (!IsWindow(hwnd)) return "lost";
    IntPtr parent = GetParent(hwnd);
    if (parent == IntPtr.Zero || !IsWindow(parent)) return "lost";
    string c = Cls(parent);
    if (c != "Progman" && c != "WorkerW") return "lost";
    // Новая схема (24H2+): после смены обоев Проводник поднимает свой слой обоев над нашим окном —
    // возвращаем окно сразу под значки
    if (c == "Progman") {
      IntPtr defView = FindWindowEx(parent, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (defView != IntPtr.Zero && GetWindow(defView, 2) != hwnd) {
        SetWindowPos(hwnd, defView, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        return "fixed";
      }
    }
    return "ok";
  }

  // Счётчики сети по каждому работающему адаптеру (скорость считает Lumen по разнице)
  public static string Net() {
    var sb = new StringBuilder();
    foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
      if (ni.OperationalStatus != OperationalStatus.Up) continue;
      if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
      try { var st = ni.GetIPStatistics(); sb.Append(ni.Id.Replace(";", "").Replace(":", "")).Append(':').Append(st.BytesReceived).Append(':').Append(st.BytesSent).Append(';'); } catch { }
    }
    return sb.Length > 0 ? sb.ToString() : "-";
  }

  // Закрыт ли рабочий стол: окно на переднем плане развёрнуто или во весь экран
  public static string Cover() {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero || !IsWindowVisible(fg)) return "0";
    string c = Cls(fg);
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Windows.UI.Core.CoreWindow" || c == "XamlExplorerHostIslandWindow") return "0";
    if (IsZoomed(fg)) return "1";
    RECT r; GetWindowRect(fg, out r);
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(fg, 2), ref mi)) return "0";
    return (r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B) ? "1" : "0";
  }
}
'@

[Console]::Out.WriteLine('ready')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Trim() -split '\s+'
    $out = ''
    try {
        switch ($p[0]) {
            'attach' { $out = [LumenDesk]::Attach([int64]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5]) }
            'place' { $out = [LumenDesk]::Replace([int64]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5]) }
            'check' { $out = [LumenDesk]::Check([int64]$p[1]) }
            'cover' { $out = [LumenDesk]::Cover() }
            'net' { $out = [LumenDesk]::Net() }
            'quit' { exit 0 }
            default { $out = 'fail:неизвестная команда' }
        }
    } catch { $out = 'fail:' + $_.Exception.Message }
    [Console]::Out.WriteLine(($out -replace '[\r\n]+', ' '))
}
