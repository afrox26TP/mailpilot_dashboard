[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "MailPilotWatchdog"
$supervisorPath = Join-Path $PSScriptRoot "mailpilot-supervisor.ps1"
$powerShellPath = Join-Path $PSHOME "powershell.exe"
$legacyTaskName = "MailPilot Watchdog"

function Stop-MailPilotWatchdogProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine -like "*mailpilot-supervisor.ps1*" -or
            $_.CommandLine -like "*mailpilot-watchdog.ps1*"
        )
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-MailPilotWatchdogProcesses
    Write-Host "Automatický watchdog MailPilotu byl odebrán."
    exit 0
}

if (-not (Test-Path $supervisorPath)) {
    throw "Supervisor nebyl nalezen: $supervisorPath"
}

# Odstraní starší variantu používající Task Scheduler.
Stop-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction SilentlyContinue

New-Item -Path $runKey -Force | Out-Null
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`""
$runCommand = "`"$powerShellPath`" $arguments"
Set-ItemProperty -Path $runKey -Name $runName -Value $runCommand -Type String

Stop-MailPilotWatchdogProcesses
Start-Process -FilePath $powerShellPath -ArgumentList $arguments -WindowStyle Hidden
Start-Sleep -Seconds 3

$running = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*mailpilot-supervisor.ps1*"
})
if ($running.Count -eq 0) {
    throw "Supervisor se nepodařilo spustit."
}

Write-Host "Automatický watchdog byl nainstalován a spuštěn."
Write-Host "Autostart: $runKey\$runName"
Write-Host "Log:       $(Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\watchdog.log')"