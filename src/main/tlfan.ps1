# Мост Lumen -> контроллер вентиляторов Lian Li UNI FAN TL (USB 0416:7372).
# Протокол взят из открытого проекта lian-li-linux (MIT): HID-пакеты по 64 байта,
# [0x01, команда, 0, 0, 0, длина данных, данные...].
#   0xA1 — опрос: какие вентиляторы на каких портах
#   0xA3 — цвет одного вентилятора (режим «статичный цвет», яркость 0–4)
# Общение с Lumen — строки JSON в stdout; команды в stdin:
#   C <hex>  — цвета всех вентиляторов подряд (порт 0, порт 1, …), по 6 hex-символов на вентилятор
#   R        — заново опросить контроллер
#   Q        — выход
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LumenTl {
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct HIDP_CAPS {
    public ushort Usage; public ushort UsagePage; public ushort InputReportByteLength; public ushort OutputReportByteLength; public ushort FeatureReportByteLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
    public ushort NumberLinkCollectionNodes; public ushort NumberInputButtonCaps; public ushort NumberInputValueCaps; public ushort NumberInputDataIndices;
    public ushort NumberOutputButtonCaps; public ushort NumberOutputValueCaps; public ushort NumberOutputDataIndices;
    public ushort NumberFeatureButtonCaps; public ushort NumberFeatureValueCaps; public ushort NumberFeatureDataIndices;
  }
  [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
  [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
  [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
  [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, ref HIDP_CAPS caps);
  [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr w, int flags);
  [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref SP_DEVICE_INTERFACE_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int req, IntPtr info);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);

  static FileStream stream;
  static int outLen = 64, inLen = 64;
  public static string Path = "";

  static List<string> Paths() {
    var res = new List<string>();
    Guid g; HidD_GetHidGuid(out g);
    IntPtr hset = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12); // PRESENT | DEVICEINTERFACE
    if (hset == new IntPtr(-1)) return res;
    try {
      for (int i = 0; ; i++) {
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        if (!SetupDiEnumDeviceInterfaces(hset, IntPtr.Zero, ref g, i, ref d)) break;
        int need; SetupDiGetDeviceInterfaceDetail(hset, ref d, IntPtr.Zero, 0, out need, IntPtr.Zero);
        if (need <= 0) continue;
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
          Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
          if (SetupDiGetDeviceInterfaceDetail(hset, ref d, buf, need, out need, IntPtr.Zero)) res.Add(Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4)));
        } finally { Marshal.FreeHGlobal(buf); }
      }
    } finally { SetupDiDestroyDeviceInfoList(hset); }
    return res;
  }

  // Найти и открыть управляющий интерфейс контроллера (usage page 0xFF1B)
  public static bool Open() {
    Close();
    foreach (var p in Paths()) {
      if (p.ToLowerInvariant().IndexOf("vid_0416&pid_7372") < 0) continue;
      var h = CreateFile(p, 0xC0000000, 3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero); // RW, share RW, OPEN_EXISTING, OVERLAPPED
      if (h.IsInvalid) continue;
      IntPtr pre; ushort page = 0; HIDP_CAPS caps = new HIDP_CAPS(); caps.Reserved = new ushort[17];
      if (HidD_GetPreparsedData(h, out pre)) { HidP_GetCaps(pre, ref caps); HidD_FreePreparsedData(pre); page = caps.UsagePage; }
      if (page != 0xFF1B || caps.OutputReportByteLength < 7) { h.Dispose(); continue; }
      outLen = caps.OutputReportByteLength; inLen = Math.Max(7, (int)caps.InputReportByteLength);
      stream = new FileStream(h, FileAccess.ReadWrite, 1, true); // без буфера: каждый отчёт уходит целиком
      Path = p;
      return true;
    }
    return false;
  }

  public static void Close() { try { if (stream != null) stream.Dispose(); } catch { } stream = null; }

  static byte[] Packet(byte cmd, byte[] data) {
    var pkt = new byte[outLen];
    pkt[0] = 0x01; pkt[1] = cmd; pkt[5] = (byte)data.Length;
    Array.Copy(data, 0, pkt, 6, Math.Min(data.Length, Math.Min(58, outLen - 6)));
    return pkt;
  }

  public static void Send(byte cmd, byte[] data) {
    var pkt = Packet(cmd, data);
    stream.Write(pkt, 0, pkt.Length);
  }

  // Отправить команду и дождаться ответа на неё (ответы на другие команды пропускаем)
  public static byte[] Ask(byte cmd, byte[] data, int timeoutMs) {
    Send(cmd, data);
    var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < until) {
      var buf = new byte[inLen];
      var ar = stream.BeginRead(buf, 0, buf.Length, null, null);
      int left = (int)Math.Max(1, (until - DateTime.UtcNow).TotalMilliseconds);
      if (!ar.AsyncWaitHandle.WaitOne(left)) return null; // чтение отменится при закрытии
      int n = stream.EndRead(ar);
      if (n > 6 && buf[1] == cmd) return buf;
    }
    return null;
  }

  // Опрос: сколько вентиляторов на каждом из 4 портов
  public static int[] Ports() {
    var r = Ask(0xA1, new byte[0], 3000);
    var counts = new int[4];
    if (r == null) return null;
    int len = r[5];
    for (int i = 0; i + 2 < len && 6 + i + 2 < r.Length; i += 3) {
      byte info = r[6 + i];
      if ((info & 0x80) == 0) continue;
      int port = (info >> 4) & 3, fan = info & 0x0F;
      counts[port] = Math.Max(counts[port], fan + 1);
    }
    return counts;
  }

  // Статичный цвет одному вентилятору; синхронизация с материнской платой выключается
  public static void FanColor(int port, int fan, byte r, byte g, byte b) {
    var p = new byte[20];
    p[0] = (byte)(port << 4);
    p[1] = (byte)((port << 4) | (fan & 0x0F));
    p[2] = 3;            // статичный цвет
    p[3] = (byte)((r | g | b) == 0 ? 0 : 4); // яркость 0–4, саму яркость Lumen уже учёл в цвете
    p[4] = 0;            // скорость
    p[5] = r; p[6] = g; p[7] = b;
    p[17] = 0;           // направление
    p[18] = 0;           // 0 — включено
    p[19] = 1;           // один цвет
    Send(0xA3, p);
  }
}
'@
} catch {
  Out-Json @{ event = 'fatal'; message = 'Не удалось подготовить мост Lian Li: ' + $_.Exception.Message }
  exit 2
}

function Report-Ports {
  $ports = $null
  try { $ports = [LumenTl]::Ports() } catch { }
  if ($ports -eq $null) {
    Out-Json @{ event = 'error'; message = 'Контроллер Lian Li не ответил на опрос' }
    [void][LumenTl]::Open() # сбросить незавершённое чтение
    return @(0, 0, 0, 0)
  }
  Out-Json @{ event = 'ports'; ports = @($ports) }
  return $ports
}

if (-not [LumenTl]::Open()) {
  Out-Json @{ event = 'none'; message = 'Контроллер Lian Li UNI FAN TL не найден' }
  exit 0
}
Out-Json @{ event = 'ready' }
$ports = Report-Ports
$last = @{}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $line = $line.Trim()
  if ($line -eq 'Q') { break }
  if ($line -eq 'R') { $ports = Report-Ports; $last = @{}; continue }
  if ($line.StartsWith('C ')) {
    $hex = $line.Substring(2)
    $k = 0
    try {
      for ($p = 0; $p -lt 4; $p++) {
        for ($f = 0; $f -lt $ports[$p]; $f++) {
          if ($hex.Length -lt ($k + 1) * 6) { break }
          $c = $hex.Substring($k * 6, 6)
          $key = "$p.$f"
          if ($last[$key] -ne $c) {
            [LumenTl]::FanColor($p, $f, [Convert]::ToByte($c.Substring(0, 2), 16), [Convert]::ToByte($c.Substring(2, 2), 16), [Convert]::ToByte($c.Substring(4, 2), 16))
            $last[$key] = $c
          }
          $k++
        }
      }
    } catch {
      Out-Json @{ event = 'error'; message = $_.Exception.Message }
      # контроллер могли отключить — пробуем открыть заново
      if (-not [LumenTl]::Open()) { Out-Json @{ event = 'none'; message = 'Контроллер Lian Li отключён' }; break }
      $last = @{}
    }
  }
}
[LumenTl]::Close()
