# Hardware test only (docs/feasibility-display-switching.md, test T5). Sends ONE DDC/CI
# "set VCP 0x60" (input source) to the monitor on this PC, then reads 0x60 back.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hw\monitor-input-set.ps1 -Input hdmi1
#   powershell -ExecutionPolicy Bypass -File scripts\hw\monitor-input-set.ps1 -Input hdmi2
#
# It changes what the monitor shows. Before running it, know how to switch back by hand:
# the monitor's control button -> Input -> HDMI 1 / HDMI 2 (or OSD Sidekick on the gaming PC).
# Only the two HDMI inputs can be sent. If more than one monitor answers DDC/CI, it stops
# and asks for -Index (see monitor-probe.ps1 for the order).
param(
  [Parameter(Mandatory = $true)][ValidateSet("hdmi1", "hdmi2")][string]$Input,
  [int]$Index = -1
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class MonitorInput {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
  public delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc cb, IntPtr data);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetVCPFeature(IntPtr h, byte code, uint value);
  [DllImport("dxva2.dll", SetLastError = true)] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, out uint current, out uint max);

  /** Physical monitors that answer DDC/CI (internal panels do not). */
  public static List<IntPtr> DdcMonitors() {
    var hms = new List<IntPtr>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hm, hdc, r, d) => { hms.Add(hm); return true; }, IntPtr.Zero);
    var result = new List<IntPtr>();
    foreach (var hm in hms) {
      uint n;
      if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) continue;
      var pm = new PHYSICAL_MONITOR[n];
      if (!GetPhysicalMonitorsFromHMONITOR(hm, n, pm)) continue;
      foreach (var p in pm) { uint len; if (GetCapabilitiesStringLength(p.h, out len)) result.Add(p.h); }
    }
    return result;
  }

  public static string Read(IntPtr h) {
    uint cur, max;
    return GetVCPFeatureAndVCPFeatureReply(h, 0x60, IntPtr.Zero, out cur, out max)
      ? string.Format("0x{0:X2}", cur)
      : string.Format("no reply (err 0x{0:X8})", Marshal.GetLastWin32Error());
  }
}
'@

$value = if ($Input -eq "hdmi1") { 0x11 } else { 0x12 }
$monitors = [MonitorInput]::DdcMonitors()
if ($monitors.Count -eq 0) { "No monitor on this PC answers DDC/CI (is the monitor on this PC's desktop?)."; exit 1 }
if ($monitors.Count -gt 1 -and $Index -lt 0) { "$($monitors.Count) monitors answer DDC/CI; pass -Index 0..$($monitors.Count - 1)."; exit 1 }
$h = $monitors[[Math]::Max($Index, 0)]
"before: VCP 0x60 = $([MonitorInput]::Read($h))"
$t = Get-Date
$ok = [MonitorInput]::SetVCPFeature($h, 0x60, $value)
"set VCP 0x60 = 0x$('{0:X2}' -f $value) ($Input): $(if ($ok) { 'accepted by Windows' } else { 'failed, err 0x{0:X8}' -f [Runtime.InteropServices.Marshal]::GetLastWin32Error() }) after $([int]((Get-Date) - $t).TotalMilliseconds) ms"
Start-Sleep -Seconds 3
"after 3 s: VCP 0x60 = $([MonitorInput]::Read($h))"
"Write down what the monitor actually shows now; 'accepted' only means the message was sent."
