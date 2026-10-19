# Read-only hardware probe (docs/feasibility-display-switching.md): asks the monitor for VCP
# values over its USB connection instead of the video cable, through the VIA "USB 2.0 BILLBOARD"
# device (2109:8886) that Gigabyte monitors expose, using the libusb-win32 driver OSD Sidekick
# installs for it. Run it on the PC the monitor's USB cable is plugged into.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hw\monitor-usb-probe.ps1
#
# Request format from community reverse engineering of OSD Sidekick (P403n1x87/m27q,
# thilobillerbeck/gbmoncli): a DDC/CI "get VCP" message (6E 51 82 01 <code>) sent as a vendor
# control transfer (0x40, request 178), then a 12-byte read (0xC0, request 162, index 111) whose
# byte 10 is the current value. Sends no "set" message.
param([string]$Codes = "10,60", [int]$VendorId = 0x2109, [int]$ProductId = 0x8886)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UsbProbe {
  const string Lib = "libusb0.dll";
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern void usb_init();
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int usb_find_busses();
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int usb_find_devices();
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr usb_get_busses();
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr usb_open(IntPtr dev);
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int usb_close(IntPtr h);
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int usb_control_msg(IntPtr h, int type, int req, int value, int index, byte[] bytes, int size, int timeout);
  [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr usb_strerror();

  // libusb-win32 0.1 structs on x64: usb_bus { next, prev, dirname[512], devices, ... },
  // usb_device { next, prev, filename[512], bus, descriptor { ..., idVendor @+8, idProduct @+10 } }.
  const int PathMax = 512;
  const int BusDevices = 16 + PathMax;
  const int DevDescriptor = 16 + PathMax + 8;

  static IntPtr Find(int vid, int pid) {
    usb_init(); usb_find_busses(); usb_find_devices();
    for (IntPtr bus = usb_get_busses(); bus != IntPtr.Zero; bus = Marshal.ReadIntPtr(bus)) {
      for (IntPtr dev = Marshal.ReadIntPtr(bus, BusDevices); dev != IntPtr.Zero; dev = Marshal.ReadIntPtr(dev)) {
        int v = (ushort)Marshal.ReadInt16(dev, DevDescriptor + 8), p = (ushort)Marshal.ReadInt16(dev, DevDescriptor + 10);
        if (v == vid && p == pid) return dev;
      }
    }
    return IntPtr.Zero;
  }

  public static string[] Read(int vid, int pid, byte[] codes) {
    var dev = Find(vid, pid);
    if (dev == IntPtr.Zero) return new[] { string.Format("no {0:x4}:{1:x4} device visible to libusb-win32 (is the monitor's USB cable on this PC, with OSD Sidekick's driver?)", vid, pid) };
    var h = usb_open(dev);
    if (h == IntPtr.Zero) return new[] { "usb_open failed: " + Marshal.PtrToStringAnsi(usb_strerror()) };
    var lines = new string[codes.Length];
    try {
      for (int i = 0; i < codes.Length; i++) {
        var req = new byte[] { 0x6E, 0x51, 0x82, 0x01, codes[i] };
        int w = usb_control_msg(h, 0x40, 178, 0, 0, req, req.Length, 1000);
        System.Threading.Thread.Sleep(50);
        var buf = new byte[12];
        int r = usb_control_msg(h, 0xC0, 162, 0, 111, buf, buf.Length, 1000);
        lines[i] = string.Format("USB get VCP 0x{0:X2}: write={1} read={2} bytes=[{3}] value(byte 10)=0x{4:X2}",
          codes[i], w, r, BitConverter.ToString(buf).Replace("-", " "), buf[10]);
        System.Threading.Thread.Sleep(50);
      }
    } finally { usb_close(h); }
    return lines;
  }
}
'@

[UsbProbe]::Read($VendorId, $ProductId, [byte[]]($Codes.Split(",") | ForEach-Object { [Convert]::ToByte($_, 16) }))
