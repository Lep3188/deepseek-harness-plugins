# Probe: does setting System.AppUserModel.ID on a .lnk actually persist, and
# does a toast render under an identity that cannot be pre-registered?
$ErrorActionPreference = 'Stop'

$programs = [Environment]::GetFolderPath('Programs')
$lnk = Join-Path $programs 'DSH Toast Probe2.lnk'
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }

$shellCom = New-Object -ComObject WScript.Shell
$shortcut = $shellCom.CreateShortcut($lnk)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -Command "exit"'
$shortcut.Save()
"1. shortcut saved"

$source = @'
using System;
using System.Runtime.InteropServices;
public static class ProbeStore {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind, int flags, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object store);
  static readonly Guid FmtId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const int Pid = 5;
  public static void Write(string path, string aumid) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    object o; SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out o);
    var s = (IPropertyStore)o;
    var k = new PropertyKey { fmtid = FmtId, pid = Pid };
    IntPtr t = Marshal.StringToCoTaskMemUni(aumid);
    var v = new PropVariant { vt = 31, p = t };
    try { s.SetValue(ref k, ref v); s.Commit(); } finally { Marshal.FreeCoTaskMem(t); }
  }
  public static string Read(string path) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    object o; SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out o);
    var s = (IPropertyStore)o;
    var k = new PropertyKey { fmtid = FmtId, pid = Pid };
    PropVariant v; s.GetValue(ref k, out v);
    if (v.vt != 31 || v.p == IntPtr.Zero) return "<empty>";
    return Marshal.PtrToStringUni(v.p);
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
"2. interop compiled"

[ProbeStore]::Write($lnk, 'DeepSeek.Harness.Probe2')
"3. wrote AUMID (no read-back: the property store holds a file handle)"

# Fire under the random suffix that cannot have a pre-existing registration.
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = '<toast duration="long"><visual><binding template="ToastGeneric"><text>DeepSeek probe 2 (unregistered id)</text><text>Sent under DeepSeek.Harness.Probe2.</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek.Harness.Probe2').Show($toast)
"4. toast dispatched under DeepSeek.Harness.Probe2"
Start-Sleep -Seconds 2
"5. done (shortcut left in place for the follow-up check)"
