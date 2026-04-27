$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
$qdrantPidFile = Join-Path $runtimeDir 'qdrant.pid'
$serverPidFile = Join-Path $runtimeDir 'server.pid'
$clientPidFile = Join-Path $runtimeDir 'client.pid'
$serverOut = Join-Path $root 'server-live.out.log'
$serverErr = Join-Path $root 'server-live.err.log'
$clientOut = Join-Path $root 'client-live.out.log'
$clientErr = Join-Path $root 'client-live.err.log'
$qdrantOut = Join-Path $root 'qdrant-live.out.log'
$qdrantErr = Join-Path $root 'qdrant-live.err.log'
$bundledNode = Join-Path $runtimeDir 'node20\node.exe'
$bundledNpm = Join-Path $runtimeDir 'node20\npm.cmd'
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }
$npmCmd = if (Test-Path $bundledNpm) { $bundledNpm } else { 'npm.cmd' }
$dockerComposeFile = Join-Path $root 'docker-compose.yml'
$localQdrantExe = Join-Path $root 'tools\qdrant\current\qdrant.exe'
$localQdrantConfig = Join-Path $root 'config\qdrant.yaml'
$qdrantStorageDir = Join-Path $root 'data\qdrant\storage'

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

function Reset-QdrantStorage() {
    if (-not (Test-Path $qdrantStorageDir)) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path (Split-Path $qdrantStorageDir -Parent) ("storage-corrupt-" + $stamp)
    try {
        Move-Item -Path $qdrantStorageDir -Destination $backupPath -Force
    } catch {
        if (Test-Path $qdrantStorageDir) {
            cmd /c "rmdir /s /q `"$qdrantStorageDir`"" | Out-Null
        }
    }
    New-Item -ItemType Directory -Force -Path $qdrantStorageDir | Out-Null
}

function Try-StartLocalQdrant() {
    if (Test-Path $qdrantOut) { Remove-Item $qdrantOut -Force -ErrorAction SilentlyContinue }
    if (Test-Path $qdrantErr) { Remove-Item $qdrantErr -Force -ErrorAction SilentlyContinue }
    $qdrantProc = Start-Process -FilePath $localQdrantExe `
        -ArgumentList @('--config-path', $localQdrantConfig) `
        -WorkingDirectory $root `
        -RedirectStandardOutput $qdrantOut `
        -RedirectStandardError $qdrantErr `
        -WindowStyle Hidden `
        -PassThru
    $qdrantProc.Id | Set-Content $qdrantPidFile
    return Wait-ForHttp 'http://127.0.0.1:6333/collections' 20
}

function Start-Qdrant() {
    if (Test-Path $localQdrantExe) {
        Write-Host '[stack] starting local Qdrant binary on http://127.0.0.1:6333'
        if (Try-StartLocalQdrant) {
            return $true
        }
        Write-Host '[stack] local Qdrant failed to start, resetting storage and retrying once'
        Stop-TrackedProcess $qdrantPidFile
        Stop-PortListener 6333
        Stop-PortListener 6334
        Reset-QdrantStorage
        if (Try-StartLocalQdrant) {
            return $true
        }
        Write-Host '[stack] local Qdrant failed after retry; backend will use vectra fallback'
        if (Test-Path $qdrantOut) { Get-Content $qdrantOut -Tail 60 }
        if (Test-Path $qdrantErr) { Get-Content $qdrantErr -Tail 60 }
        return $false
    }

    if (Test-Path $dockerComposeFile) {
        Write-Host '[stack] starting Qdrant via docker compose on http://127.0.0.1:6333'
        docker compose -f $dockerComposeFile up -d qdrant | Out-Host
        if (-not (Wait-ForHttp 'http://127.0.0.1:6333/collections' 20)) {
            Write-Host '[stack] docker Qdrant failed to start or is not reachable'
            return $false
        }
        return $true
    }

    Write-Host '[stack] no local Qdrant binary or docker-compose.yml found'
    return $false
}

Write-Host '[stack] stopping previous tracked processes'
Stop-TrackedProcess $qdrantPidFile
Stop-TrackedProcess $serverPidFile
Stop-TrackedProcess $clientPidFile

Write-Host '[stack] clearing ports 8000 and 5173'
Stop-PortListener 8000
Stop-PortListener 5173
Start-Sleep -Seconds 1

foreach ($log in @($qdrantOut, $qdrantErr, $serverOut, $serverErr, $clientOut, $clientErr)) {
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
}

$qdrantReady = Start-Qdrant

Write-Host '[stack] starting backend on http://localhost:8000'
$serverProc = if ($qdrantReady) {
    Start-Process -FilePath $nodeExe `
        -ArgumentList 'index.js' `
        -WorkingDirectory (Join-Path $root 'server') `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverErr `
        -WindowStyle Hidden `
        -PassThru
} else {
    $nodeCmd = '"' + $nodeExe + '" index.js'
    Start-Process -FilePath cmd.exe `
        -ArgumentList @('/c', "set QDRANT_ENABLED=0&& $nodeCmd") `
        -WorkingDirectory (Join-Path $root 'server') `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverErr `
        -WindowStyle Hidden `
        -PassThru
}
$serverProc.Id | Set-Content $serverPidFile

if (-not (Wait-ForHttp 'http://localhost:8000' 20)) {
    Write-Host '[stack] backend failed to start'
    if (Test-Path $serverErr) { Get-Content $serverErr -Tail 60 }
    exit 1
}

Write-Host '[stack] starting frontend on http://localhost:5173'
$clientProc = Start-Process -FilePath $npmCmd `
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

if ($qdrantReady) {
    Write-Host '[stack] qdrant   : http://127.0.0.1:6333'
    if (Test-Path $qdrantPidFile) { Write-Host "[stack] qdrant pid: $((Get-Content $qdrantPidFile | Select-Object -First 1))" }
} else {
    Write-Host '[stack] qdrant   : disabled for this run, backend using vectra fallback'
}
Write-Host '[stack] backend  : http://localhost:8000'
Write-Host '[stack] frontend : http://localhost:5173'
Write-Host "[stack] server pid: $($serverProc.Id)"
Write-Host "[stack] client pid: $($clientProc.Id)"
