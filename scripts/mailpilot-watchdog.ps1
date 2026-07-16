[CmdletBinding()]
param(
    [int]$CheckIntervalSeconds = 15,
    [int]$FailureThreshold = 3
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$BackendPath = Join-Path $ProjectRoot "backend\app.py"
$TunnelConfig = Join-Path $env:USERPROFILE ".cloudflared\mailpilot.yml"
$LogDirectory = Join-Path $ProjectRoot "logs"
$WatchdogLog = Join-Path $LogDirectory "watchdog.log"
$script:LastHeartbeat = Get-Date

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

function Write-WatchdogLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    if ((Test-Path $WatchdogLog) -and (Get-Item $WatchdogLog).Length -gt 5MB) {
        Move-Item -Force $WatchdogLog "$WatchdogLog.1"
    }

    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
}

function Get-EnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$DefaultValue
    )

    $envFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $envFile) {
        $match = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -Last 1
        if ($match) {
            return (($match -split "=", 2)[1].Trim().Trim('"').Trim("'"))
        }
    }
    return $DefaultValue
}

function Get-CloudflaredPath {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Cloudflare\cloudflared.exe"),
        (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    throw "cloudflared.exe nebyl nalezen."
}

function Get-TunnelSetting {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Test-Path $TunnelConfig)) {
        throw "Konfigurace tunelu nebyla nalezena: $TunnelConfig"
    }
    $pattern = "^\s*(?:-\s*)?$([regex]::Escape($Name)):\s*(.+?)\s*$"
    foreach ($line in Get-Content $TunnelConfig) {
        $match = [regex]::Match($line, $pattern)
        if ($match.Success) {
            return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
        }
    }
    throw "V konfiguraci tunelu chybí hodnota '$Name'."
}

function Get-MailPilotBackendProcesses {
    $pythonNormalized = $PythonPath.ToLowerInvariant()
    return @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.ToLowerInvariant() -eq $pythonNormalized -and
        $_.CommandLine -and
        ($_.CommandLine -match "backend[\\/]app\.py")
    })
}

function Get-MailPilotTunnelProcesses {
    param([Parameter(Mandatory = $true)][string]$TunnelId)

    return @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($TunnelId)
    })
}

function Test-WebEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][int[]]$AllowedStatusCodes
    )

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 10
        return $AllowedStatusCodes -contains [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response) {
            return $AllowedStatusCodes -contains [int]$_.Exception.Response.StatusCode
        }
        return $false
    }
}

function Start-MailPilotBackend {
    if (-not (Test-Path $PythonPath)) {
        throw "Python prostředí nebylo nalezeno: $PythonPath"
    }
    if (-not (Test-Path $BackendPath)) {
        throw "Backend nebyl nalezen: $BackendPath"
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Start-Process -FilePath $PythonPath `
        -ArgumentList @($BackendPath) `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDirectory "backend-$timestamp.out.log") `
        -RedirectStandardError (Join-Path $LogDirectory "backend-$timestamp.error.log") | Out-Null
    Write-WatchdogLog "Backend byl spuštěn."
}

function Restart-MailPilotBackend {
    foreach ($process in Get-MailPilotBackendProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Start-MailPilotBackend
}

function Start-MailPilotTunnel {
    param(
        [Parameter(Mandatory = $true)][string]$CloudflaredPath,
        [Parameter(Mandatory = $true)][string]$TunnelId
    )

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $arguments = @("tunnel", "--config", "`"$TunnelConfig`"", "run", $TunnelId)
    Start-Process -FilePath $CloudflaredPath `
        -ArgumentList $arguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDirectory "cloudflared-$timestamp.out.log") `
        -RedirectStandardError (Join-Path $LogDirectory "cloudflared-$timestamp.error.log") | Out-Null
    Write-WatchdogLog "Cloudflare Tunnel byl spuštěn."
}

function Restart-MailPilotTunnel {
    param(
        [Parameter(Mandatory = $true)][string]$CloudflaredPath,
        [Parameter(Mandatory = $true)][string]$TunnelId
    )

    foreach ($process in Get-MailPilotTunnelProcesses -TunnelId $TunnelId) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Start-MailPilotTunnel -CloudflaredPath $CloudflaredPath -TunnelId $TunnelId
}

$lockPath = Join-Path $LogDirectory "watchdog.lock"
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch [System.IO.IOException] {
    Write-WatchdogLog "Jiná instance watchdogu již běží."
    exit 0
}

try {
    $port = Get-EnvValue -Name "PORT" -DefaultValue "5000"
    $localHealthUrl = "http://127.0.0.1:$port/api/health"
    $cloudflaredPath = Get-CloudflaredPath
    $tunnelId = Get-TunnelSetting -Name "tunnel"
    $hostname = Get-TunnelSetting -Name "hostname"
    $publicHealthUrl = "https://$hostname/api/health"
    $backendFailures = 0
    $tunnelFailures = 0

    Write-WatchdogLog "Watchdog byl spuštěn. Kontrola každých $CheckIntervalSeconds sekund."

    if (-not (Test-WebEndpoint -Uri $localHealthUrl -AllowedStatusCodes @(200, 401))) {
        Restart-MailPilotBackend
        Start-Sleep -Seconds 4
    }
    if ((Get-MailPilotTunnelProcesses -TunnelId $tunnelId).Count -eq 0) {
        Start-MailPilotTunnel -CloudflaredPath $cloudflaredPath -TunnelId $tunnelId
        Start-Sleep -Seconds 4
    }

    while ($true) {
        $backendHealthy = Test-WebEndpoint -Uri $localHealthUrl -AllowedStatusCodes @(200, 401)
        if ($backendHealthy) {
            $backendFailures = 0
        }
        else {
            $backendFailures++
            Write-WatchdogLog "Lokální backend neodpovídá ($backendFailures/$FailureThreshold)."
            if ($backendFailures -ge $FailureThreshold) {
                Write-WatchdogLog "Restartuji nefunkční backend."
                Restart-MailPilotBackend
                $backendFailures = 0
                Start-Sleep -Seconds 4
                $backendHealthy = Test-WebEndpoint -Uri $localHealthUrl -AllowedStatusCodes @(200, 401)
            }
        }

        if ((Get-MailPilotTunnelProcesses -TunnelId $tunnelId).Count -eq 0) {
            Write-WatchdogLog "Proces tunelu neběží; spouštím jej znovu."
            Start-MailPilotTunnel -CloudflaredPath $cloudflaredPath -TunnelId $tunnelId
            $tunnelFailures = 0
            Start-Sleep -Seconds 4
        }
        elseif ($backendHealthy) {
            if (Test-WebEndpoint -Uri $publicHealthUrl -AllowedStatusCodes @(200, 401)) {
                $tunnelFailures = 0
            }
            else {
                $tunnelFailures++
                Write-WatchdogLog "Veřejný endpoint neodpovídá ($tunnelFailures/$FailureThreshold)."
                if ($tunnelFailures -ge $FailureThreshold) {
                    Write-WatchdogLog "Restartuji nefunkční Cloudflare Tunnel."
                    Restart-MailPilotTunnel -CloudflaredPath $cloudflaredPath -TunnelId $tunnelId
                    $tunnelFailures = 0
                }
            }
        }

        if (((Get-Date) - $script:LastHeartbeat).TotalMinutes -ge 5) {
            Write-WatchdogLog "Kontrola OK."
            $script:LastHeartbeat = Get-Date
        }
        Start-Sleep -Seconds $CheckIntervalSeconds
    }
}
catch {
    Write-WatchdogLog "Watchdog skončil chybou: $($_.Exception.Message)"
    throw
}
finally {
    if ($lockStream) {
        $lockStream.Dispose()
    }
}