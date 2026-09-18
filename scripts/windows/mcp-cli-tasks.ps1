<#
.SYNOPSIS
    Install, inspect, repair and roll back the mcp-cli daemon and bridge as
    Windows scheduled tasks, with a watchdog that brings either back.

.DESCRIPTION
    Three tasks, all running as the interactive user at logon:

      mcp-cli-daemon    wscript shim -> node dist/cli/index.js daemon serve
      mcp-cli-bridge    wscript shim -> node dist/cli/index.js bridge serve
      mcp-cli-watchdog  every two minutes: this script with -Action watchdog

    Why a wscript shim and not node.exe as the task action. Task Scheduler
    allocates a console for a console-subsystem action, and a console for an
    interactive-user task is a window that flashes on every start. wscript.exe
    is a GUI-subsystem process, so no console is allocated, and its Run call
    with bWaitOnReturn=True does not return until node exits and then returns
    node's exit code. The task is therefore running exactly as long as the
    node process is, and fails exactly when node fails, which is what the
    scheduler's restart-on-failure needs: three restarts a minute apart. A
    detached child, the previous arrangement, gave the scheduler nothing to
    supervise. (conhost --headless was tried for the same purpose and hung.)

    The watchdog is the recovery that has been seen to work. Measured on this
    Windows 11 build (2026-09-18): the scheduler's restart-on-failure did not
    rerun a task whose action exited non-zero, neither a trigger-started task
    whose node was killed (exit -1) nor a probe task of `cmd /c exit 1`; the
    setting evidently covers a failure to launch the action, not the action
    failing. It is configured as specified and costs nothing, and the
    watchdog covers every other case: a process that died, one that is alive
    and not answering, and one whose task never started. Every two minutes it
    probes /health/ready (daemon) and /health/live (bridge), ends the task,
    kills any node still holding the port, and starts the task again. A
    `paused` marker in the state directory makes it look and not act.

    Every install first exports the current task definitions and copies the
    current shims into a timestamped backup under the state directory, and
    -Action rollback restores the newest backup, or the one -Backup names.

    Idempotent: running install twice leaves one set of tasks and one set of
    shims. Add -Restart to end the running services and start the new code.

.PARAMETER Action
    install | status | repair | watchdog | rollback | uninstall | pause | resume

.PARAMETER Root
    The checkout whose dist/cli/index.js the tasks run. Defaults to the
    repository this script lives in.

.PARAMETER TaskPrefix
    The prefix of the three task names and shim files, mcp-cli by default. An
    isolated run on other ports uses another prefix and never touches the
    live tasks.

.PARAMETER GenerateBridgeToken
    With install: if the config's bridge.authTokenEnv names a variable that is
    not set for this user, set it to a fresh random value. The value is never
    printed or written anywhere but the user's environment.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action install -Restart
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action status
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action rollback
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'status', 'repair', 'watchdog', 'rollback', 'uninstall', 'pause', 'resume')]
    [string]$Action = 'status',
    [string]$Root = '',
    [string]$Node = '',
    [string]$Config = (Join-Path $env:USERPROFILE '.agents\mcp-cli.json'),
    [int]$DaemonPort = 8791,
    [int]$BridgePort = 8790,
    [string]$ShimDir = (Join-Path $env:USERPROFILE 'rig\bin'),
    [string]$StateDir = (Join-Path $env:USERPROFILE '.agents\mcp-cli-tasks'),
    [string]$LogDir = (Join-Path $env:USERPROFILE '.agents'),
    [string]$Backup = '',
    [string]$TaskPrefix = 'mcp-cli',
    [switch]$Restart,
    [switch]$GenerateBridgeToken,
    [switch]$NoBridge
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# The default root is resolved here and not in the parameter list: under
# `powershell -File` the automatic variables are empty while parameters bind,
# so a default expression that reads $PSScriptRoot fails before the body runs.
$ScriptPath = $MyInvocation.MyCommand.Path
if ($Root -eq '') {
    $Root = (Resolve-Path (Join-Path (Split-Path -Parent $ScriptPath) '..\..')).Path
}

$TaskDaemon = "$TaskPrefix-daemon"
$TaskBridge = "$TaskPrefix-bridge"
$TaskWatchdog = "$TaskPrefix-watchdog"
$AllTasks = @($TaskDaemon, $TaskBridge, $TaskWatchdog)
$PausedMarker = Join-Path $StateDir 'paused'
$WatchdogLog = Join-Path $StateDir 'watchdog.log'
$Entry = Join-Path $Root 'dist\cli\index.js'
$DaemonLog = Join-Path $LogDir 'mcp-cli-daemon.log'
$BridgeLog = Join-Path $LogDir 'mcp-cli-bridge.log'
$ShimDaemon = Join-Path $ShimDir "$TaskPrefix-daemon-hidden.vbs"
$ShimBridge = Join-Path $ShimDir "$TaskPrefix-bridge-hidden.vbs"
$ShimWatchdog = Join-Path $ShimDir "$TaskPrefix-watchdog-hidden.vbs"
$ShimBridgePs1 = Join-Path $ShimDir "$TaskPrefix-bridge.ps1"

function Write-Log {
    param([string]$Line)
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    if ($Action -eq 'watchdog') {
        if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
        if ((Test-Path $WatchdogLog) -and ((Get-Item $WatchdogLog).Length -gt 1MB)) {
            Move-Item -Force $WatchdogLog ($WatchdogLog + '.1')
        }
        Add-Content -Path $WatchdogLog -Value "$stamp $Line" -Encoding utf8
    } else {
        # Write-Host, not Write-Output: a function that returns a value must
        # not have its log lines captured into that value by the caller.
        Write-Host "$stamp $Line"
    }
}

function Resolve-Node {
    if ($Node -ne '') { return $Node }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { throw 'node.exe is not on PATH; pass -Node' }
    return $cmd.Source
}

function Test-Health {
    param([int]$Port, [string]$Path)
    try {
        $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$Port$Path"
        return ($res.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-HealthJson {
    param([int]$Port, [string]$Path)
    try {
        $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$Port$Path"
        return ($res.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-ServiceProcesses {
    # Only the node that serves THIS port: another daemon on another port,
    # such as a live one beside an isolated test, is never touched.
    param([string]$Kind)
    $pattern = if ($Kind -eq 'daemon') { 'daemon serve' } else { 'bridge serve' }
    $port = if ($Kind -eq 'daemon') { $DaemonPort } else { $BridgePort }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match [regex]::Escape($pattern) -and
        $_.CommandLine -match 'index\.js' -and
        $_.CommandLine -match ('--port\s+' + $port + '(\s|$)')
    }
}

function Get-TaskOrNull {
    param([string]$Name)
    return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Read-ConfigJson {
    if (-not (Test-Path $Config)) { throw "config file not found: $Config" }
    return (Get-Content -Raw -Path $Config | ConvertFrom-Json)
}

function Get-BridgeBind {
    $cfg = Read-ConfigJson
    $bind = '0.0.0.0'
    $tokenEnv = $null
    if ($cfg.PSObject.Properties['bridge']) {
        if ($cfg.bridge.PSObject.Properties['bind']) { $bind = $cfg.bridge.bind }
        if ($cfg.bridge.PSObject.Properties['authTokenEnv']) { $tokenEnv = $cfg.bridge.authTokenEnv }
    }
    return @{ Bind = $bind; TokenEnv = $tokenEnv }
}

function Test-Loopback {
    param([string]$Bind)
    $b = $Bind.Trim().ToLower()
    return ($b -eq 'localhost' -or $b -eq '::1' -or $b -eq '[::1]' -or $b.StartsWith('127.'))
}

# ---------------------------------------------------------------- shims --

function Write-Shims {
    param([string]$NodeExe)
    if (-not (Test-Path $ShimDir)) { New-Item -ItemType Directory -Force $ShimDir | Out-Null }

    $daemonCmd = ('""{0}"" ""{1}"" daemon serve --port {2} --config ""{3}"" --log ""{4}""' -f $NodeExe, $Entry, $DaemonPort, $Config, $DaemonLog)
    $bridgeCmd = ('""{0}"" ""{1}"" bridge serve --port {2} --config ""{3}"" --log ""{4}""' -f $NodeExe, $Entry, $BridgePort, $Config, $BridgeLog)
    $watchdogCmd = ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{0}"" -Action watchdog -Root ""{1}"" -Config ""{2}"" -DaemonPort {3} -BridgePort {4} -ShimDir ""{5}"" -StateDir ""{6}"" -LogDir ""{7}"" -TaskPrefix ""{8}""{9}' -f $ScriptPath, $Root, $Config, $DaemonPort, $BridgePort, $ShimDir, $StateDir, $LogDir, $TaskPrefix, $(if ($NoBridge) { ' -NoBridge' } else { '' }))

    $shim = @'
' Generated by scripts/windows/mcp-cli-tasks.ps1. Do not edit; rerun install.
' wscript.exe is a GUI-subsystem process, so Task Scheduler allocates no
' console, the 0 hides the child's window, and the True makes Run wait for the
' child and return its exit code, so the task lives and fails with the child.
Dim shell
Set shell = CreateObject("Wscript.Shell")
WScript.Quit shell.Run("{0}", 0, True)
'@
    Set-Content -Path $ShimDaemon -Value ($shim -f $daemonCmd) -Encoding ascii
    Set-Content -Path $ShimBridge -Value ($shim -f $bridgeCmd) -Encoding ascii
    Set-Content -Path $ShimWatchdog -Value ($shim -f $watchdogCmd) -Encoding ascii

    $ps1 = @"
# Superseded by the mcp-cli-bridge scheduled task, which runs the same command
# through mcp-cli-bridge-hidden.vbs. Kept so a person can run the bridge in the
# foreground and read its output. Generated by scripts/windows/mcp-cli-tasks.ps1.
& '$NodeExe' '$Entry' bridge serve --port $BridgePort --config '$Config'
exit `$LASTEXITCODE
"@
    Set-Content -Path $ShimBridgePs1 -Value $ps1 -Encoding utf8
    Write-Log "shims written under $ShimDir"
}

# --------------------------------------------------------------- backup --

function New-Backup {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $dir = Join-Path $StateDir ("backup\" + $stamp)
    New-Item -ItemType Directory -Force $dir | Out-Null
    $manifest = @{ at = $stamp; tasks = @(); shims = @() }
    foreach ($name in $AllTasks) {
        $task = Get-TaskOrNull $name
        if ($null -ne $task) {
            Export-ScheduledTask -TaskName $name | Set-Content -Path (Join-Path $dir "$name.xml") -Encoding unicode
            $manifest.tasks += $name
        }
    }
    foreach ($shim in @($ShimDaemon, $ShimBridge, $ShimWatchdog, $ShimBridgePs1)) {
        if (Test-Path $shim) {
            Copy-Item $shim (Join-Path $dir (Split-Path -Leaf $shim))
            $manifest.shims += (Split-Path -Leaf $shim)
        }
    }
    ($manifest | ConvertTo-Json) | Set-Content -Path (Join-Path $dir 'manifest.json') -Encoding utf8
    Write-Log "backup written to $dir (tasks: $($manifest.tasks -join ', '); shims: $($manifest.shims -join ', '))"
    return $dir
}

# ------------------------------------------------------------- register --

function Register-ServiceTask {
    param([string]$Name, [string]$Shim)
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $Shim)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "registered $Name (logon trigger, 3 restarts a minute apart, start when available)"
}

function Register-WatchdogTask {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $ShimWatchdog)
    $every = New-TimeSpan -Minutes 2
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval $every -RepetitionDuration (New-TimeSpan -Days 3650)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    $logon.Repetition = $repeat.Repetition
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskWatchdog -Action $action -Trigger @($repeat, $logon) -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "registered $TaskWatchdog (every 2 minutes, from logon and from now)"
}

# ------------------------------------------------------------ lifecycle --

function Stop-Service {
    param([string]$Kind, [string]$TaskName)
    $task = Get-TaskOrNull $TaskName
    if ($null -ne $task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Log "ended task $TaskName"
    }
    $procs = @(Get-ServiceProcesses $Kind)
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Log "killed $Kind node pid $($p.ProcessId) (started $($p.CreationDate))"
    }
}

function Start-Service {
    param([string]$Kind, [string]$TaskName, [int]$Port, [string]$ReadyPath, [int]$WaitSeconds = 60)
    Start-ScheduledTask -TaskName $TaskName
    Write-Log "started task $TaskName; waiting up to ${WaitSeconds}s for http://127.0.0.1:$Port$ReadyPath"
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Health $Port $ReadyPath) {
            Write-Log "$Kind is healthy on port $Port"
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Log "$Kind did not answer on port $Port within ${WaitSeconds}s; its log is $(if ($Kind -eq 'daemon') { $DaemonLog } else { $BridgeLog })"
    return $false
}

function Invoke-Watch {
    param([switch]$Verbose_)
    $paused = Test-Path $PausedMarker
    $results = @{}
    $services = @(@{ Kind = 'daemon'; Task = $TaskDaemon; Port = $DaemonPort; Path = '/health/ready' })
    if (-not $NoBridge) { $services += @{ Kind = 'bridge'; Task = $TaskBridge; Port = $BridgePort; Path = '/health/live' } }
    foreach ($s in $services) {
        $healthy = Test-Health $s.Port $s.Path
        if ($healthy) {
            $results[$s.Kind] = 'healthy'
            if ($Verbose_) { Write-Log "$($s.Kind) healthy" }
            continue
        }
        if ($paused) {
            $results[$s.Kind] = 'unhealthy, paused'
            Write-Log "$($s.Kind) unhealthy on port $($s.Port); paused marker present, not restarting"
            continue
        }
        if ($null -eq (Get-TaskOrNull $s.Task)) {
            $results[$s.Kind] = 'unhealthy, no task'
            Write-Log "$($s.Kind) unhealthy and task $($s.Task) is not registered; run -Action install"
            continue
        }
        Write-Log "$($s.Kind) unhealthy on port $($s.Port); restarting"
        Stop-Service $s.Kind $s.Task
        $ok = Start-Service $s.Kind $s.Task $s.Port $s.Path 60
        $results[$s.Kind] = if ($ok) { 'restarted' } else { 'restart failed' }
    }
    return $results
}

# ---------------------------------------------------------------- status --

function Show-Status {
    Write-Output "root      $Root"
    Write-Output "entry     $Entry $(if (Test-Path $Entry) { '(present)' } else { '(MISSING)' })"
    Write-Output "config    $Config $(if (Test-Path $Config) { '(present)' } else { '(MISSING)' })"
    Write-Output "paused    $(Test-Path $PausedMarker)"
    foreach ($name in $AllTasks) {
        $task = Get-TaskOrNull $name
        if ($null -eq $task) { Write-Output "task      $name  (not registered)"; continue }
        $info = Get-ScheduledTaskInfo -TaskName $name
        $actions = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; '
        Write-Output ("task      {0}  state={1} lastRun={2} lastResult={3} restarts={4}/{5} startWhenAvailable={6}" -f $name, $task.State, $info.LastRunTime, $info.LastTaskResult, $task.Settings.RestartCount, $task.Settings.RestartInterval, $task.Settings.StartWhenAvailable)
        Write-Output "          action: $actions"
    }
    foreach ($kind in @('daemon', 'bridge')) {
        $port = if ($kind -eq 'daemon') { $DaemonPort } else { $BridgePort }
        $path = if ($kind -eq 'daemon') { '/status' } else { '/status' }
        $json = Get-HealthJson $port $path
        $procs = @(Get-ServiceProcesses $kind | ForEach-Object { "pid=$($_.ProcessId) since=$($_.CreationDate)" })
        if ($null -eq $json) {
            Write-Output "${kind}    port ${port}: NOT ANSWERING; node: $(if ($procs.Count) { $procs -join ', ' } else { 'none' })"
        } elseif ($kind -eq 'daemon') {
            $warm = @($json.servers | ForEach-Object { $_.server }) -join ', '
            $prewarm = ($json.prewarm.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
            Write-Output "${kind}    port ${port}: pid=$($json.pid) up=$($json.uptimeSeconds)s ready=$($json.ready) warm=[$warm] prewarm=[$prewarm]"
        } else {
            Write-Output "${kind}    port ${port}: pid=$($json.pid) up=$($json.uptimeSeconds)s auth=$($json.auth) active=$($json.active) queued=$($json.queued)"
        }
    }
}

# --------------------------------------------------------------- actions --

switch ($Action) {
    'install' {
        $nodeExe = Resolve-Node
        if (-not (Test-Path $Entry)) { throw "built entry point not found: $Entry (run npm run build in $Root)" }
        if (-not (Test-Path $Config)) { throw "config file not found: $Config" }
        & $nodeExe $Entry servers --config $Config | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "the config file does not load: $Config" }
        if (-not $NoBridge) {
            $bridge = Get-BridgeBind
            if (-not (Test-Loopback $bridge.Bind)) {
                if ($null -eq $bridge.TokenEnv) { throw "bridge.bind is $($bridge.Bind); set bridge.authTokenEnv in $Config to the NAME of the token variable" }
                $current = [Environment]::GetEnvironmentVariable($bridge.TokenEnv, 'User')
                if ([string]::IsNullOrWhiteSpace($current)) {
                    if (-not $GenerateBridgeToken) { throw "user environment variable $($bridge.TokenEnv) is not set; set it, or rerun with -GenerateBridgeToken" }
                    $bytes = New-Object byte[] 32
                    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
                    $value = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
                    [Environment]::SetEnvironmentVariable($bridge.TokenEnv, $value, 'User')
                    Write-Log "set user environment variable $($bridge.TokenEnv) to a fresh 64-character token (value not shown)"
                } else {
                    Write-Log "bridge token variable $($bridge.TokenEnv) is set for this user"
                }
            }
        }
        if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
        New-Backup | Out-Null
        Write-Shims $nodeExe
        Register-ServiceTask $TaskDaemon $ShimDaemon
        if (-not $NoBridge) { Register-ServiceTask $TaskBridge $ShimBridge } elseif ($null -ne (Get-TaskOrNull $TaskBridge)) { Unregister-ScheduledTask -TaskName $TaskBridge -Confirm:$false }
        Register-WatchdogTask
        if ($Restart) {
            Stop-Service 'daemon' $TaskDaemon
            if (-not $NoBridge) { Stop-Service 'bridge' $TaskBridge }
        }
        $ok = $true
        if ($Restart -or -not (Test-Health $DaemonPort '/health/live')) { $ok = (Start-Service 'daemon' $TaskDaemon $DaemonPort '/health/ready' 90) -and $ok } else { Write-Log 'daemon already healthy; left running (use -Restart to load the new build)' }
        if (-not $NoBridge) {
            if ($Restart -or -not (Test-Health $BridgePort '/health/live')) { $ok = (Start-Service 'bridge' $TaskBridge $BridgePort '/health/live' 60) -and $ok } else { Write-Log 'bridge already healthy; left running (use -Restart to load the new build)' }
        }
        Show-Status
        if (-not $ok) { exit 1 }
    }
    'status' { Show-Status }
    'repair' {
        $r = Invoke-Watch -Verbose_
        Show-Status
        if ($r.Values -contains 'restart failed') { exit 1 }
    }
    'watchdog' {
        try {
            $r = Invoke-Watch
            # One line per tick, healthy or not: a watchdog whose log stops
            # growing is a watchdog that stopped running.
            Write-Log ("tick " + (($r.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '))
        } catch {
            Write-Log "watchdog error: $($_.Exception.Message)"
            exit 1
        }
    }
    'rollback' {
        $dir = $Backup
        if ($dir -eq '') {
            $latest = Get-ChildItem -Directory (Join-Path $StateDir 'backup') -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
            if ($null -eq $latest) { throw "no backup under $StateDir\backup" }
            $dir = $latest.FullName
        }
        if (-not (Test-Path (Join-Path $dir 'manifest.json'))) { throw "not a backup directory: $dir" }
        $manifest = Get-Content -Raw (Join-Path $dir 'manifest.json') | ConvertFrom-Json
        Write-Log "rolling back from $dir"
        Stop-Service 'daemon' $TaskDaemon
        Stop-Service 'bridge' $TaskBridge
        foreach ($name in $AllTasks) {
            $xml = Join-Path $dir "$name.xml"
            if (Test-Path $xml) {
                Register-ScheduledTask -TaskName $name -Xml (Get-Content -Raw $xml) -Force | Out-Null
                Write-Log "restored task $name"
            } elseif ($null -ne (Get-TaskOrNull $name)) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
                Write-Log "removed task $name (absent from the backup)"
            }
        }
        foreach ($leaf in @($manifest.shims)) {
            Copy-Item (Join-Path $dir $leaf) (Join-Path $ShimDir $leaf) -Force
            Write-Log "restored shim $leaf"
        }
        foreach ($name in @($TaskDaemon, $TaskBridge)) {
            if ($null -ne (Get-TaskOrNull $name)) { Start-ScheduledTask -TaskName $name; Write-Log "started $name" }
        }
        Show-Status
    }
    'uninstall' {
        New-Backup | Out-Null
        Stop-Service 'daemon' $TaskDaemon
        Stop-Service 'bridge' $TaskBridge
        foreach ($name in $AllTasks) {
            if ($null -ne (Get-TaskOrNull $name)) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Log "removed task $name" }
        }
    }
    'pause' {
        if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
        Set-Content -Path $PausedMarker -Value (Get-Date).ToString('o') -Encoding ascii
        Write-Log "paused: the watchdog will report but not restart (marker $PausedMarker)"
    }
    'resume' {
        if (Test-Path $PausedMarker) { Remove-Item $PausedMarker -Force }
        Write-Log 'resumed: the watchdog restarts again'
    }
}
