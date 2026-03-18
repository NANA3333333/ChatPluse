$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
$serverPidFile = Join-Path $runtimeDir 'server.pid'
$clientPidFile = Join-Path $runtimeDir 'client.pid'
$serverOut = Join-Path $root 'server-live.out.log'
$serverErr = Join-Path $root 'server-live.err.log'
$clientOut = Join-Path $root 'client-live.out.log'
$clientErr = Join-Path $root 'client-live.err.log'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Stop-TrackedProcess($pidFile) {
    if (-not (Test-Path $pidFile)) { return }
    $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $raw) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; return }
    $trackedPid = 0
    if (-not [int]::TryParse($raw, [ref]$trackedPid)) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return
    }
    $proc = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $trackedPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
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

function Wait-ForHttp($url, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
                return $true
            }
        } catch {
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Write-Host '[stack] stopping previous tracked processes'
Stop-TrackedProcess $serverPidFile
Stop-TrackedProcess $clientPidFile

Write-Host '[stack] clearing ports 8000 and 5173'
Stop-PortListener 8000
Stop-PortListener 5173
Start-Sleep -Seconds 1

foreach ($log in @($serverOut, $serverErr, $clientOut, $clientErr)) {
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
}

Write-Host '[stack] starting backend on http://localhost:8000'
$serverProc = Start-Process -FilePath node `
    -ArgumentList 'index.js' `
    -WorkingDirectory (Join-Path $root 'server') `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -WindowStyle Hidden `
    -PassThru
$serverProc.Id | Set-Content $serverPidFile

if (-not (Wait-ForHttp 'http://localhost:8000' 20)) {
    Write-Host '[stack] backend failed to start'
    if (Test-Path $serverErr) { Get-Content $serverErr -Tail 60 }
    exit 1
}

Write-Host '[stack] starting frontend on http://localhost:5173'
$clientProc = Start-Process -FilePath npm.cmd `
    -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
    -WorkingDirectory (Join-Path $root 'client') `
    -RedirectStandardOutput $clientOut `
    -RedirectStandardError $clientErr `
    -WindowStyle Hidden `
    -PassThru
$clientProc.Id | Set-Content $clientPidFile

if (-not (Wait-ForHttp 'http://localhost:5173' 25)) {
    Write-Host '[stack] frontend failed to start'
    if (Test-Path $clientErr) { Get-Content $clientErr -Tail 60 }
    exit 1
}

Write-Host '[stack] backend  : http://localhost:8000'
Write-Host '[stack] frontend : http://localhost:5173'
Write-Host "[stack] server pid: $($serverProc.Id)"
Write-Host "[stack] client pid: $($clientProc.Id)"
