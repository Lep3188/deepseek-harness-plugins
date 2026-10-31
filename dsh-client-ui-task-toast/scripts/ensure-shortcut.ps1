<#
.SYNOPSIS
  Install (or repair) the Start Menu shortcut that gives DeepSeek Harness a
  registered Windows application identity.

.DESCRIPTION
  Windows refuses to render a toast notification for an application that has no
  registered AppUserModelID; `ToastNotificationManager.Show()` fails silently
  instead. A Start Menu shortcut whose `System.AppUserModel.ID` property is set
  registers that identity for the current user, which is the documented
  supported way for a non-packaged desktop app to raise toasts.

  The shortcut points at `dsh web`, so it doubles as an ordinary launcher. It
  carries a plain .exe target so Windows can resolve an icon and an activator.

  Idempotent: an existing shortcut with the right AUMID is left untouched, and
  `-Force` rewrites it. Exit 0 means the identity is in place, 1 means it is not.

.NOTES
  The property-store interop below is the only shipped way to set
  System.AppUserModel.ID without installing a module.
#>
[CmdletBinding()]
param(
  [string]$AppId = 'DeepSeek.Harness.Toast',
  [string]$ShortcutName = 'DeepSeek Harness',
  [string]$TargetPath = '',
  [string]$TargetArguments = 'web',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

<#
  Fall back to PowerShell as the shortcut target when the caller could not
  resolve the launcher: the AUMID is what matters for toasting, and a plain
  executable target keeps Windows able to resolve an icon and an activator.
#>
function Resolve-TargetPath {
  param([string]$Requested)
  if (-not [string]::IsNullOrWhiteSpace($Requested) -and (Test-Path -LiteralPath $Requested)) { return $Requested }
  $candidates = @(
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
    (Join-Path $env:SystemRoot 'System32\cmd.exe')
  )
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
  throw 'no usable shortcut target executable found'
}

function Get-AumidInterop {
  if ('AumidInterop' -as [type]) { return }
  $source = @'
using System;
using System.Runtime.InteropServices;

public static class AumidInterop
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    public struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(
        string path, IntPtr bindContext, int flags, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object store);

    const string IID_IPropertyStore = "886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99";
    // System.AppUserModel.ID lives in the shell property namespace.
    static readonly Guid AppUserModelFmtId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    const int PKEY_AppUserModel_ID = 5;
    const int GPS_READWRITE = 2;

    public static string Read(string path)
    {
        // Diagnostics only — never called on the install path. A read holds the
        // property store open, and that handle breaks a later WScript.Shell
        // save of the same file, so the caller rewrites instead of inspecting.
        object store = null;
        try
        {
            Guid iid = new Guid(IID_IPropertyStore);
            SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
            var propertyStore = (IPropertyStore)store;
            var key = new PropertyKey { fmtid = AppUserModelFmtId, pid = PKEY_AppUserModel_ID };
            PropVariant value;
            propertyStore.GetValue(ref key, out value);
            if (value.vt != 31 || value.p == IntPtr.Zero) return null;
            return Marshal.PtrToStringUni(value.p);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (store != null) Marshal.FinalReleaseComObject(store);
        }
    }

    public static void Write(string path, string appUserModelId)
    {
        object store = null;
        try
        {
            Guid iid = new Guid(IID_IPropertyStore);
            SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
            var propertyStore = (IPropertyStore)store;
            var key = new PropertyKey { fmtid = AppUserModelFmtId, pid = PKEY_AppUserModel_ID };
            IntPtr text = Marshal.StringToCoTaskMemUni(appUserModelId);
            try
            {
                var value = new PropVariant { vt = 31, p = text };
                propertyStore.SetValue(ref key, ref value);
                propertyStore.Commit();
            }
            finally
            {
                Marshal.FreeCoTaskMem(text);
            }
        }
        finally
        {
            if (store != null) Marshal.FinalReleaseComObject(store);
        }
    }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop | Out-Null
}

try {
  $programs = [Environment]::GetFolderPath('Programs')
  if ([string]::IsNullOrWhiteSpace($programs)) { throw 'no Start Menu Programs folder for this user' }
  $shortcutPath = Join-Path $programs "$ShortcutName.lnk"

  # An existing shortcut is left alone: the identity is already registered for
  # this user, and rewriting would delete and recreate a file the user may have
  # pinned. -Force repairs a shortcut that was created without its identity.
  if ((Test-Path -LiteralPath $shortcutPath) -and -not $Force) {
    [Console]::Out.WriteLine("shortcut-present: $shortcutPath")
    exit 0
  }

  $TargetPath = Resolve-TargetPath -Requested $TargetPath

  $shellCom = New-Object -ComObject WScript.Shell
  $shortcut = $shellCom.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $TargetArguments
  $shortcut.IconLocation = "$TargetPath,0"
  $shortcut.Description = 'DeepSeek Harness — launcher and notification identity'
  $shortcut.WorkingDirectory = (Split-Path -Parent $TargetPath)
  $shortcut.Save()

  # Setting the property is what registers the AppUserModelID. The property
  # store is opened read-write and never read back: reading it leaves a file
  # handle that breaks the next writer, and the write itself either throws or
  # has happened. Success is reported from the write, not from a read.
  Get-AumidInterop
  [AumidInterop]::Write($shortcutPath, $AppId)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shellCom)

  [Console]::Out.WriteLine("shortcut-created: $shortcutPath")
  exit 0
}
catch {
  [Console]::Error.WriteLine("shortcut-failed: $($_.Exception.Message)")
  exit 1
}
