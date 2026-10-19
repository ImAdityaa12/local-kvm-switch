# Read-only hardware probe for the display-switching feasibility tests
# (docs/feasibility-display-switching.md). Changes nothing on the monitor or in Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hw\monitor-probe.ps1          monitors, DDC/CI, topology
#   powershell -ExecutionPolicy Bypass -File scripts\hw\monitor-probe.ps1 -Usb     also list connected USB devices
#
# For each monitor on this PC's desktop it prints what DDC/CI answers: the MCCS
# capability string and the current value of a few VCP codes. 0x60 is the input
# source (MCCS: 0x11 HDMI 1, 0x12 HDMI 2). Internal laptop panels do not speak
# DDC/CI and show "no reply".
param([switch]$Usb)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MonitorProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  public delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc cb, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder buf, uint len);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, out uint current, out uint max);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, out uint topology);

  public static List<string> Monitors(byte[] codes) {
    var lines = new List<string>();
    var hms = new List<IntPtr>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hm, hdc, r, d) => { hms.Add(hm); return true; }, IntPtr.Zero);
    foreach (var hm in hms) {
      var info = new MONITORINFOEX(); info.cbSize = Marshal.SizeOf(info);
      GetMonitorInfo(hm, ref info);
      uint n;
      if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) { lines.Add(info.szDevice + ": no physical monitor handle"); continue; }
      var pm = new PHYSICAL_MONITOR[n];
      if (!GetPhysicalMonitorsFromHMONITOR(hm, n, pm)) { lines.Add(info.szDevice + ": GetPhysicalMonitors failed"); continue; }
      foreach (var p in pm) {
        lines.Add(string.Format("{0} {1}x{2}", info.szDevice, info.rcMonitor.r - info.rcMonitor.l, info.rcMonitor.b - info.rcMonitor.t));
        uint len;
        if (!GetCapabilitiesStringLength(p.h, out len)) { lines.Add("  DDC/CI: no reply (err 0x" + Marshal.GetLastWin32Error().ToString("X8") + ")"); continue; }
        var sb = new StringBuilder((int)len);
        lines.Add(CapabilitiesRequestAndCapabilitiesReply(p.h, sb, len) ? "  caps: " + sb : "  caps: request failed");
        foreach (var c in codes) {
          uint cur, max;
          lines.Add(GetVCPFeatureAndVCPFeatureReply(p.h, c, IntPtr.Zero, out cur, out max)
            ? string.Format("  VCP 0x{0:X2}: current=0x{1:X2} max=0x{2:X2}", c, cur, max)
            : string.Format("  VCP 0x{0:X2}: no reply (err 0x{1:X8})", c, Marshal.GetLastWin32Error()));
        }
      }
      DestroyPhysicalMonitors(n, pm);
    }
    return lines;
  }

  public static string Topology() {
    uint p, m, topo;
    // QDC_DATABASE_CURRENT (0x4) also returns the topology id.
    if (GetDisplayConfigBufferSizes(4, out p, out m) != 0) return "topology: GetDisplayConfigBufferSizes failed";
    IntPtr pa = Marshal.AllocHGlobal((int)(p * 72)), ma = Marshal.AllocHGlobal((int)(m * 64));
    try {
      int rc = QueryDisplayConfig(4, ref p, pa, ref m, ma, out topo);
      if (rc != 0) return "topology: QueryDisplayConfig failed " + rc;
      string name = topo == 1 ? "INTERNAL (PC screen only)" : topo == 2 ? "CLONE (Duplicate)" : topo == 4 ? "EXTEND" : topo == 8 ? "EXTERNAL (Second screen only)" : "unknown";
      return "topology: " + name + ", active paths: " + p;
    } finally { Marshal.FreeHGlobal(pa); Marshal.FreeHGlobal(ma); }
  }
}
'@

"== $env:COMPUTERNAME  $(Get-Date -Format s)"
[MonitorProbe]::Topology()
"== Monitors Windows knows (EDID)"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | ForEach-Object {
  $name = -join [char[]]($_.UserFriendlyName | Where-Object { $_ })
  $conn = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams | Where-Object InstanceName -eq $_.InstanceName
  $tech = switch ($conn.VideoOutputTechnology) { 5 { "HDMI" } 10 { "DisplayPort" } 2147483648 { "internal" } default { "$($conn.VideoOutputTechnology)" } }
  "  $($_.InstanceName)  '$name'  $tech  active=$($_.Active)"
}
"== DDC/CI (read only)"
[MonitorProbe]::Monitors([byte[]](0x60, 0x10, 0xD6))
if ($Usb) {
  "== Connected USB devices (compare with the monitor's USB cable unplugged)"
  Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^(USB|HID)\\' } |
    Sort-Object InstanceId | ForEach-Object { "  $($_.InstanceId)  $($_.FriendlyName)  [$($_.Class)]" }
}
