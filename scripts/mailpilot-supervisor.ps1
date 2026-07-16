$ErrorActionPreference = "Continue"
$watchdogPath = Join-Path $PSScriptRoot "mailpilot-watchdog.ps1"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "logs"
$supervisorLog = Join-Path $logDirectory "supervisor.log"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

while ($true) {
    try {
        & $watchdogPath
        $result = $LASTEXITCODE
        if ($null -eq $result) {
            $result = 0
        }
        Add-Content -Path $supervisorLog -Encoding UTF8 -Value (
            "[{0}] Watchdog skončil s kódem {1}; další spuštění za 10 sekund." -f
            (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $result
        )
    }
    catch {
        Add-Content -Path $supervisorLog -Encoding UTF8 -Value (
            "[{0}] Watchdog skončil výjimkou: {1}; další spuštění za 10 sekund." -f
            (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $_.Exception.Message
        )
    }
    Start-Sleep -Seconds 10
}