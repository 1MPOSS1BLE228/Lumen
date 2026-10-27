# Lumen: кнопки виджетов на рабочем столе.
# Виджеты нарисованы на обоях под значками, поэтому нажать на них нельзя. Этот помощник смотрит,
# куда щёлкнули мышью: если по самому рабочему столу (не по окну) и ровно в кнопку виджета —
# сообщает Lumen. Клик никуда не перехватывается, рабочий стол получает его как обычно.
# Пока рабочий стол закрыт игрой или окном, слежение за мышью выключено совсем.
# stdin:  R id л в п н;id л в п н   — кнопки (в пикселях экрана), пусто — кнопок нет
#         P — пауза (рабочий стол закрыт), U — снова следить, Q — выход
# stdout: {"event":"ready"} | {"event":"hover","id":"..."} | {"event":"click","id":"..."}
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LumenInput {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
  delegate IntPtr LLProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, LLProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  class Btn { public string Id; public int L, T, R, B; }
  static volatile Btn[] btns = new Btn[0];
  static LLProc proc = Hook; // держим ссылку, иначе сборщик мусора уберёт обработчик
  static IntPtr hook = IntPtr.Zero;
  static uint loopThread;
  static string hover = null, down = null;
  static readonly object outLock = new object();

  public static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static void Emit(string ev, string id) {
    lock (outLock) {
      Console.Out.WriteLine("{\"event\":\"" + ev + "\",\"id\":\"" + (id ?? "") + "\"}");
      Console.Out.Flush();
    }
  }

  public static void SetRects(string spec) {
    var list = new List<Btn>();
    foreach (var part in (spec ?? "").Split(';')) {
      var f = part.Trim().Split(' ');
      if (f.Length != 5) continue;
      int l, t, r, b;
      if (!int.TryParse(f[1], out l) || !int.TryParse(f[2], out t) || !int.TryParse(f[3], out r) || !int.TryParse(f[4], out b)) continue;
      list.Add(new Btn { Id = f[0], L = l, T = t, R = r, B = b });
    }
    btns = list.ToArray();
  }

  static string Hit(int x, int y) {
    foreach (var b in btns) if (x >= b.L && x < b.R && y >= b.T && y < b.B) return b.Id;
    return null;
  }

  // Под курсором именно рабочий стол (а не окно поверх него)?
  static bool OnDesktop(POINT p) {
    IntPtr w = WindowFromPoint(p);
    if (w == IntPtr.Zero) return false;
    IntPtr root = GetAncestor(w, 2);
    var sb = new StringBuilder(64);
    GetClassName(root == IntPtr.Zero ? w : root, sb, 64);
    string c = sb.ToString();
    return c == "Progman" || c == "WorkerW";
  }

  static IntPtr Hook(int n, IntPtr w, IntPtr l) {
    try {
      if (n >= 0 && btns.Length > 0) {
        var m = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        int msg = w.ToInt32();
        string id = Hit(m.pt.X, m.pt.Y);
        if (id != null && !OnDesktop(m.pt)) id = null;
        if (msg == 0x0200) { if (id != hover) { hover = id; Emit("hover", id); } }
        else if (msg == 0x0201) { down = id; }
        else if (msg == 0x0202) { if (down != null && down == id) Emit("click", id); down = null; }
      }
    } catch { }
    return CallNextHookEx(hook, n, w, l);
  }

  // Включить слежение: отдельный поток с очередью сообщений (так требует Windows для такого обработчика)
  public static void Start() {
    if (loopThread != 0 || btns.Length == 0) return;
    var ready = new ManualResetEvent(false);
    var t = new Thread(() => {
      loopThread = GetCurrentThreadId();
      hook = SetWindowsHookEx(14, proc, GetModuleHandle(null), 0); // WH_MOUSE_LL
      ready.Set();
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
      if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
    });
    t.IsBackground = true;
    t.Start();
    ready.WaitOne(3000);
  }

  public static void Stop() {
    if (loopThread != 0) { PostThreadMessage(loopThread, 0x0012, IntPtr.Zero, IntPtr.Zero); loopThread = 0; } // WM_QUIT
    Thread.Sleep(50);
    hover = null; down = null;
  }

  public static bool Active { get { return loopThread != 0; } }
}
'@
} catch {
  [Console]::Out.WriteLine('{"event":"fatal","id":""}')
  exit 2
}

[LumenInput]::DpiAware()
$paused = $false
[Console]::Out.WriteLine('{"event":"ready","id":""}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'Q') { break }
  if ($line.StartsWith('R')) {
    [LumenInput]::SetRects($line.Substring(1).Trim())
    if ($line.Trim().Length -gt 1 -and -not $paused) { [LumenInput]::Start() } elseif ($line.Trim().Length -le 1) { [LumenInput]::Stop() }
  } elseif ($line -eq 'P') { $paused = $true; [LumenInput]::Stop() }
  elseif ($line -eq 'U') { $paused = $false; [LumenInput]::Start() }
}
[LumenInput]::Stop()
