<#
  One-time setup of the Minecraft agent (scripts/minecraft-pc-agent.js) on the
  PC that hosts the server. Run it elevated, on that PC:

    powershell -ExecutionPolicy Bypass -File scripts\minecraft-pc-setup.ps1 -GemixHost 192.168.1.50

  It registers a task that starts the agent at boot under this account, before
  anyone logs in, with its output in src\logs\minecraft-agent.log, and a
  firewall rule that lets only the GemiX server reach the agent's port, on
  every network profile. Rerunning it replaces both and restarts the agent.
#>
param(
  [Parameter(Mandatory = $true)] [string] $GemixHost,
  [int] $Port = 25580
)
$ErrorActionPreference = 'Stop'

$name = 'GemiX Minecraft agent'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force (Join-Path $repo 'src\logs') | Out-Null

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $repo `
  -Argument "/d /c `"`"$node`" scripts\minecraft-pc-agent.js >> src\logs\minecraft-agent.log 2>&1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Force | Out-Null

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Port `
  -RemoteAddress $GemixHost -Action Allow -Profile Any | Out-Null

# Whatever holds the port (an agent from an earlier run) gives way to the new one.
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-ScheduledTask -TaskName $name
Write-Host "Agent started at boot as $env:USERNAME; port $Port open to $GemixHost only."
