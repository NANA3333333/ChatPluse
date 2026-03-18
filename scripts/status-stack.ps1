$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
$serverPidFile = Join-Path $runtimeDir 'server.pid'
$clientPidFile = Join-Path $runtimeDir 'client.pid'

function Show-TrackedProcess($name, $pidFile, $port, $url) {
    $pidText = if (Test-Path $pidFile) { (Get-Content $pidFile | Select-Object -First 1) } else { '' }
    $state = 'stopped'
    $procName = ''
    if ($pidText) {
        $trackedPid = 0
        if ([int]::TryParse($pidText, [ref]$trackedPid)) {
            $proc = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
            if ($proc) {
                $state = 'running'
                $procName = $proc.ProcessName
            }
        }
    }
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $listening = if ($listener) { 'yes' } else { 'no' }
    $pidDisplay = if ([string]::IsNullOrWhiteSpace($pidText)) { '-' } else { $pidText }
    $procDisplay = if ([string]::IsNullOrWhiteSpace($procName)) { '-' } else { $procName }
    Write-Host ("[{0}] state={1} pid={2} process={3} port={4} listening={5} url={6}" -f $name, $state, $pidDisplay, $procDisplay, $port, $listening, $url)
}

Show-TrackedProcess 'backend' $serverPidFile 8000 'http://localhost:8000'
Show-TrackedProcess 'frontend' $clientPidFile 5173 'http://localhost:5173'
