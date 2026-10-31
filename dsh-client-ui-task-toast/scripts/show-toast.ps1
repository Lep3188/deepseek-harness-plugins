<#
.SYNOPSIS
  Show one Windows toast notification for DeepSeek Harness.

.DESCRIPTION
  The host half of the task-toast plugin spawns this script with `-File` (never
  `-Command`, so nothing the GUI sends is ever parsed as PowerShell). Payload
  text arrives base64-encoded as UTF-8, so a session title containing quotes,
  newlines, or PowerShell metacharacters is inert by construction.

  Windows only renders a toast for an application with a registered identity;
  `-AppId` names the AppUserModelID carried by the Start Menu shortcut that
  `ensure-shortcut.ps1` installs. `ToastNotificationManager.Show()` returns
  without throwing even when no identity matches, so this script also reports
  what it did on stdout for the host to log.

.NOTES
  Exits 0 when a toast was handed to Windows, 1 on any failure, so the caller
  can distinguish "sent" from "silently dropped".
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TitleB64,
  [Parameter(Mandatory = $true)][string]$BodyB64,
  [string]$AppId = 'DeepSeek.Harness.Toast'
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-B64Text {
  param([string]$Value)
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

function Escape-Xml {
  param([string]$Value)
  return $Value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

try {
  $title = ConvertFrom-B64Text $TitleB64
  $body = ConvertFrom-B64Text $BodyB64

  # Load the WinRT projections before the type literals are resolved.
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

  # duration="long" keeps the toast in the Action Center until dismissed.
  # No activation attributes: the safe default (focus the notification) applies.
  $xml = @"
<toast duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$(Escape-Xml $title)</text>
      <text>$(Escape-Xml $body)</text>
    </binding>
  </visual>
</toast>
"@

  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

  [Console]::Out.WriteLine('toast-shown')
  exit 0
}
catch {
  [Console]::Error.WriteLine("toast-failed: $($_.Exception.Message)")
  exit 1
}
