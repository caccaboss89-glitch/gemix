<#
  Shows the admin a Windows notification about the Minecraft server. The
  agent cannot show one itself: it runs at boot with no desktop, so it writes
  src\logs\minecraft-notice.json and starts the "GemiX Minecraft notice" task
  that scripts\minecraft-pc-setup.ps1 registers in the admin's own session,
  which runs this script.

  The file holds {"title": "...", "body": "..."}. The notification appears
  under the name and icon of GemiX (icon.png in the repository root).
#>
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$notice = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'src\logs\minecraft-notice.json') | ConvertFrom-Json
$appId = 'GemiX'
$icon = Join-Path $repo 'icon.png'

# Windows shows a notification under the name and icon of a registered app only.
$settings = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$appId"
New-Item -Path $settings -Force | Out-Null
New-ItemProperty -Path $settings -Name 'ShowInActionCenter' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $settings -Name 'Enabled' -Value 1 -PropertyType DWord -Force | Out-Null
$app = "HKCU:\Software\Classes\AppUserModelId\$appId"
New-Item -Path $app -Force | Out-Null
New-ItemProperty -Path $app -Name 'DisplayName' -Value 'GemiX' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $app -Name 'IconUri' -Value $icon -PropertyType String -Force | Out-Null

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$title = [Security.SecurityElement]::Escape([string]$notice.title)
$body = [Security.SecurityElement]::Escape([string]$notice.body)
$logo = [Security.SecurityElement]::Escape($icon)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast duration=`"short`"><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text><image placement=`"appLogoOverride`" src=`"$logo`"/></binding></visual></toast>")

$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$toast.Tag = 'minecraft'
$toast.Group = 'minecraft'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
