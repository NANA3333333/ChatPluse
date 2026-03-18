$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
$serverPidFile = Join-Path $runtimeDir 'server.pid'
$clientPidFile = Join-Path $runtimeDir 'client.pid'

function Stop-TrackedProcess($pidFile) {
    if (-not (Test-Path $pidFile)) { return }
    $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($raw) {
        $trackedPid = 0
        if ([int]::TryParse($raw, [ref]$trackedPid)) {
            Stop-Process -Id $trackedPid -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-PortListener($port) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in ($listeners | Where-Object { $_ })) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

Stop-TrackedProcess $serverPidFile
Stop-TrackedProcess $clientPidFile
Stop-PortListener 8000
Stop-PortListener 5173

Write-Host '[stack] stopped ports 8000 and 5173'
