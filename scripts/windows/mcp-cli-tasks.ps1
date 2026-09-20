<#
.SYNOPSIS
    Install, inspect, repair and roll back the mcp-cli daemon and bridge as
    Windows scheduled tasks, each supervised from inside its own task, with a
    watchdog that brings either back.

.DESCRIPTION
    Three tasks, all running as the interactive user at logon:

      mcp-cli-daemon    wscript shim -> this script -Action run -Service daemon -> node daemon serve
      mcp-cli-bridge    wscript shim -> this script -Action run -Service bridge -> node bridge serve
      mcp-cli-watchdog  every two minutes: this script with -Action watchdog

    The recovery contract, as measured on this box:

      A process that exits is started again by the supervisor loop inside its
      task, within a few seconds (2 s backoff, doubling to 30 s while it keeps
      failing, a 60 s pause after ten exits in five minutes, and never giving
      up). A process that is alive but not answering its readiness probe, or a
      task that is not running at all, is caught by the watchdog on its next
      tick, at most two minutes later, and back within about a minute after
      that. The scheduler's own restart-on-failure is configured on both
      service tasks and is not relied on; what it does on this build is
      recorded by -Action probe-restart and quoted by -Action status as
      observed, never assumed.

    Why a wscript shim and not node.exe as the task action. Task Scheduler
    allocates a console for a console-subsystem action, and a console for an
    interactive-user task is a window that flashes on every start. wscript.exe
    is a GUI-subsystem process, so no console is allocated; the 0 hides the
    child's window and the True makes Run wait for the child and return its
    exit code, so the task is running exactly as long as the supervisor is.

    Why a supervisor loop and not the scheduler's restart setting. On this
    Windows 11 build (first seen 2026-09-18) restart-on-failure was not seen
    to rerun a task whose action had started and then exited non-zero. The
    loop does not depend on how the scheduler defines "failure": it waits for
    node, reads the exit code, logs it, and starts node again.

    The watchdog probes /health/ready on both services. When the supervisor
    loop is alive and only node is unhealthy, it kills node and lets the loop
    start it. When the loop is gone, it ends the task, kills the loop's pid
    and any node still holding the port, and starts the task again. A
    `paused` marker in the state directory makes the loop exit after the next
    node exit and makes the watchdog look and not act.

    Every install first exports the current task definitions and copies the
    current shims into a timestamped backup under the state directory, and
    -Action rollback restores the newest backup, or the one -Backup names.

    Idempotent: running install twice leaves one set of tasks and one set of
    shims. Add -Restart to end the running services and start the new code.

.PARAMETER Action
    install | status | repair | watchdog | run | probe-restart | rollback |
    uninstall | pause | resume

.PARAMETER Service
    With -Action run: daemon or bridge.

.PARAMETER Root
    The checkout whose dist/cli/index.js the tasks run. Defaults to the
    repository this script lives in.

.PARAMETER TaskPrefix
    The prefix of the three task names and shim files, mcp-cli by default. An
    isolated run on other ports uses another prefix and never touches the
    live tasks.

.PARAMETER ProbeMinutes
    With -Action probe-restart: how long each probe task is observed.

.PARAMETER GenerateBridgeToken
    With install: if the config's bridge.authTokenEnv names a variable that is
    not set for this user, set it to a fresh random value. The value is never
    printed or written anywhere but the user's environment.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action install -Restart
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action status
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action probe-restart
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\mcp-cli-tasks.ps1 -Action rollback
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'status', 'repair', 'watchdog', 'run', 'probe-restart', 'rollback', 'uninstall', 'pause', 'resume')]
    [string]$Action = 'status',
    [ValidateSet('', 'daemon', 'bridge')]
    [string]$Service = '',
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
    [int]$ProbeMinutes = 4,
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
$ProbeResult = Join-Path $StateDir 'restart-probe.json'
$Entry = Join-Path $Root 'dist\cli\index.js'
$DaemonLog = Join-Path $LogDir 'mcp-cli-daemon.log'
$BridgeLog = Join-Path $LogDir 'mcp-cli-bridge.log'
$ShimDaemon = Join-Path $ShimDir "$TaskPrefix-daemon-hidden.vbs"
$ShimBridge = Join-Path $ShimDir "$TaskPrefix-bridge-hidden.vbs"
$ShimWatchdog = Join-Path $ShimDir "$TaskPrefix-watchdog-hidden.vbs"
$ShimBridgePs1 = Join-Path $ShimDir "$TaskPrefix-bridge.ps1"

function Get-SupervisorPidFile { param([string]$Kind) return (Join-Path $StateDir "$Kind-supervisor.pid") }
function Get-SupervisorLog { param([string]$Kind) return (Join-Path $StateDir "$Kind-supervisor.log") }

function Add-LogLine {
    param([string]$Path, [string]$Line)
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
    if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt 1MB)) {
        Move-Item -Force $Path ($Path + '.1')
    }
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    Add-Content -Path $Path -Value "$stamp $Line" -Encoding utf8
}

function Write-Log {
    param([string]$Line)
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    if ($Action -eq 'watchdog') {
        Add-LogLine $WatchdogLog $Line
    } elseif ($Action -eq 'run') {
        Add-LogLine (Get-SupervisorLog $Service) $Line
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

function Get-SupervisorProcess {
    # The supervisor loop of THIS service and THIS prefix, when its pid file
    # names a living powershell that is running this script's run action.
    param([string]$Kind)
    $file = Get-SupervisorPidFile $Kind
    if (-not (Test-Path $file)) { return $null }
    $raw = (Get-Content -Path $file -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $procId = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$procId)) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $null }
    if ($proc.CommandLine -notmatch '-Action\s+run' -or $proc.CommandLine -notmatch ('-Service\s+' + $Kind) -or $proc.CommandLine -notmatch ('-TaskPrefix\s+"?' + [regex]::Escape($TaskPrefix) + '"?(\s|$)')) { return $null }
    return $proc
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

function Get-CommonArgs {
    # The arguments every re-invocation of this script carries, so a shim and
    # a supervisor address the same tasks, ports and directories.
    return ('-Root ""{0}"" -Config ""{1}"" -DaemonPort {2} -BridgePort {3} -ShimDir ""{4}"" -StateDir ""{5}"" -LogDir ""{6}"" -TaskPrefix ""{7}""{8}' -f $Root, $Config, $DaemonPort, $BridgePort, $ShimDir, $StateDir, $LogDir, $TaskPrefix, $(if ($NoBridge) { ' -NoBridge' } else { '' }))
}

# ---------------------------------------------------------------- shims --

function Write-Shims {
    param([string]$NodeExe)
    if (-not (Test-Path $ShimDir)) { New-Item -ItemType Directory -Force $ShimDir | Out-Null }

    $common = Get-CommonArgs
    $nodeArg = if ($Node -ne '') { ' -Node ""{0}""' -f $Node } else { '' }
    $daemonCmd = ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{0}"" -Action run -Service daemon {1}{2}' -f $ScriptPath, $common, $nodeArg)
    $bridgeCmd = ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{0}"" -Action run -Service bridge {1}{2}' -f $ScriptPath, $common, $nodeArg)
    $watchdogCmd = ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{0}"" -Action watchdog {1}' -f $ScriptPath, $common)

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
# Superseded by the $TaskBridge scheduled task, which runs the same command
# under a supervisor loop through $TaskPrefix-bridge-hidden.vbs. Kept so a
# person can run the bridge in the foreground and read its output.
# Generated by scripts/windows/mcp-cli-tasks.ps1.
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
    Write-Log "registered $Name (logon trigger, supervisor loop inside the task, scheduler restart 3/PT1M configured and not relied on)"
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
    # The supervisor first, so it cannot start node again while node is
    # being killed; then node; then the task, which is the shim's wscript.
    param([string]$Kind, [string]$TaskName)
    $sup = Get-SupervisorProcess $Kind
    if ($null -ne $sup) {
        Stop-Process -Id $sup.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Log "killed $Kind supervisor pid $($sup.ProcessId)"
    }
    Remove-Item (Get-SupervisorPidFile $Kind) -Force -ErrorAction SilentlyContinue
    $procs = @(Get-ServiceProcesses $Kind)
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Log "killed $Kind node pid $($p.ProcessId) (started $($p.CreationDate))"
    }
    $task = Get-TaskOrNull $TaskName
    if ($null -ne $task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Log "ended task $TaskName"
    }
}

function Wait-Health {
    param([string]$Kind, [int]$Port, [string]$ReadyPath, [int]$WaitSeconds)
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

function Start-Service {
    param([string]$Kind, [string]$TaskName, [int]$Port, [string]$ReadyPath, [int]$WaitSeconds = 60)
    if ($null -ne (Get-SupervisorProcess $Kind)) {
        Write-Log "$Kind supervisor is alive; not starting the task twice"
    } else {
        Start-ScheduledTask -TaskName $TaskName
        Write-Log "started task $TaskName; waiting up to ${WaitSeconds}s for http://127.0.0.1:$Port$ReadyPath"
    }
    return (Wait-Health $Kind $Port $ReadyPath $WaitSeconds)
}

function Invoke-Watch {
    param([switch]$Verbose_)
    $paused = Test-Path $PausedMarker
    $results = @{}
    $services = @(@{ Kind = 'daemon'; Task = $TaskDaemon; Port = $DaemonPort; Path = '/health/ready' })
    if (-not $NoBridge) { $services += @{ Kind = 'bridge'; Task = $TaskBridge; Port = $BridgePort; Path = '/health/ready' } }
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
        $sup = Get-SupervisorProcess $s.Kind
        if ($null -ne $sup) {
            # The loop is alive: node is hung or not ready. Kill node alone and
            # let the loop start it; no second loop is started.
            Write-Log "$($s.Kind) unhealthy on port $($s.Port); supervisor pid $($sup.ProcessId) alive, killing node for it to restart"
            foreach ($p in @(Get-ServiceProcesses $s.Kind)) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Log "killed $($s.Kind) node pid $($p.ProcessId) (started $($p.CreationDate))"
            }
            $ok = Wait-Health $s.Kind $s.Port $s.Path 60
            $results[$s.Kind] = if ($ok) { 'restarted by supervisor' } else { 'restart failed' }
            continue
        }
        Write-Log "$($s.Kind) unhealthy on port $($s.Port) and no supervisor; restarting the task"
        Stop-Service $s.Kind $s.Task
        $ok = Start-Service $s.Kind $s.Task $s.Port $s.Path 60
        $results[$s.Kind] = if ($ok) { 'restarted' } else { 'restart failed' }
    }
    return $results
}

# ------------------------------------------------------------ supervisor --

function Invoke-Supervisor {
    # Runs inside the service task: start node, wait, log the exit, start it
    # again. Exits only when paused or when another supervisor took the pid
    # file, so the task is running exactly as long as the service is meant
    # to be.
    param([string]$Kind)
    $nodeExe = Resolve-Node
    $port = if ($Kind -eq 'daemon') { $DaemonPort } else { $BridgePort }
    $logFile = if ($Kind -eq 'daemon') { $DaemonLog } else { $BridgeLog }
    $verb = if ($Kind -eq 'daemon') { 'daemon' } else { 'bridge' }
    $pidFile = Get-SupervisorPidFile $Kind
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
    Set-Content -Path $pidFile -Value $PID -Encoding ascii
    Write-Log "supervisor pid $PID for $Kind on port $port; entry $Entry"
    $count = 0
    $backoff = 2
    $recent = New-Object System.Collections.ArrayList
    while ($true) {
        if (Test-Path $PausedMarker) { Write-Log 'paused marker present; supervisor exiting'; break }
        $owner = (Get-Content -Path $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ("$owner".Trim() -ne "$PID") { Write-Log "pid file names $owner, not $PID; supervisor exiting"; break }
        $started = Get-Date
        $argList = @('"' + $Entry + '"', $verb, 'serve', '--port', $port, '--config', ('"' + $Config + '"'), '--log', ('"' + $logFile + '"'))
        try {
            $proc = Start-Process -FilePath $nodeExe -ArgumentList $argList -NoNewWindow -PassThru
        } catch {
            Write-Log "could not start node: $($_.Exception.Message)"
            Start-Sleep -Seconds 30
            continue
        }
        $proc.WaitForExit()
        $code = $proc.ExitCode
        $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
        $count += 1
        Write-Log ("restart n={0} code={1} after={2}ms pid={3}" -f $count, $code, $elapsed, $proc.Id)
        if (Test-Path $PausedMarker) { Write-Log 'paused marker present; not restarting'; break }
        [void]$recent.Add((Get-Date))
        while ($recent.Count -gt 0 -and ((Get-Date) - $recent[0]).TotalSeconds -gt 300) { $recent.RemoveAt(0) }
        if ($recent.Count -ge 10) {
            Write-Log 'ten exits within five minutes; pausing 60s before the next start'
            Start-Sleep -Seconds 60
        } else {
            if ($elapsed -ge 60000) { $backoff = 2 }
            Start-Sleep -Seconds $backoff
            $backoff = [Math]::Min(30, $backoff * 2)
        }
    }
    $owner = (Get-Content -Path $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ("$owner".Trim() -eq "$PID") { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------ probe --

function Invoke-RestartProbe {
    # Four throwaway tasks, each with the same restart-on-failure setting the
    # services carry, each writing one line per run. After -ProbeMinutes the
    # line counts say what the scheduler did. The file holds observations;
    # the conclusion is the reader's.
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $dir = Join-Path $StateDir 'restart-probe'
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $p1log = Join-Path $dir 'p1.log'
    $p3log = Join-Path $dir 'p3.log'
    $p4log = Join-Path $dir 'p4.log'
    $p3shim = Join-Path $dir 'p3.vbs'
    $p3cmd = ('cmd.exe /c ""echo %DATE% %TIME% >> ""{0}"" & exit 1""' -f $p3log)
    Set-Content -Path $p3shim -Value ("Dim shell`r`nSet shell = CreateObject(""Wscript.Shell"")`r`nWScript.Quit shell.Run(""{0}"", 0, True)" -f $p3cmd) -Encoding ascii
    $probes = @(
        @{ Name = 'p1'; What = 'cmd exit 1'; Execute = 'cmd.exe'; Argument = ('/c "echo %DATE% %TIME% >> "{0}" & exit 1"' -f $p1log); Logon = 'Interactive'; Log = $p1log },
        @{ Name = 'p2'; What = 'missing exe'; Execute = 'C:\does\not\exist\mcp-cli-probe.exe'; Argument = ''; Logon = 'Interactive'; Log = $null },
        @{ Name = 'p3'; What = 'wscript shim around cmd exit 1'; Execute = 'wscript.exe'; Argument = ('"{0}"' -f $p3shim); Logon = 'Interactive'; Log = $p3log },
        @{ Name = 'p4'; What = 'cmd exit 1 under S4U'; Execute = 'cmd.exe'; Argument = ('/c "echo %DATE% %TIME% >> "{0}" & exit 1"' -f $p4log); Logon = 'S4U'; Log = $p4log }
    )
    $startedAt = Get-Date
    foreach ($p in $probes) {
        $name = "$TaskPrefix-probe-$($p.Name)"
        $p.Task = $name
        $p.Error = $null
        try {
            $action = if ($p.Argument -ne '') { New-ScheduledTaskAction -Execute $p.Execute -Argument $p.Argument } else { New-ScheduledTaskAction -Execute $p.Execute }
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $p.Logon -RunLevel Limited
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15)
            Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
            Write-Log "registered $name ($($p.What))"
        } catch {
            $p.Error = $_.Exception.Message
            Write-Log "could not register $name ($($p.What)): $($p.Error)"
        }
    }
    Write-Log "observing for $ProbeMinutes minutes"
    Start-Sleep -Seconds ($ProbeMinutes * 60 + 20)
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = $startedAt } -ErrorAction Stop | Where-Object { $_.Message -match [regex]::Escape("$TaskPrefix-probe-") } | ForEach-Object { @{ time = $_.TimeCreated.ToString('o'); id = $_.Id; message = ($_.Message -replace '\s+', ' ').Substring(0, [Math]::Min(160, ($_.Message -replace '\s+', ' ').Length)) } })
        $eventsNote = "$($events.Count) events read"
    } catch {
        $eventsNote = "operational log not readable: $($_.Exception.Message)"
    }
    $observations = @()
    foreach ($p in $probes) {
        $runs = 0
        if ($null -ne $p.Log -and (Test-Path $p.Log)) { $runs = @(Get-Content $p.Log).Count }
        $info = $null
        try { $info = Get-ScheduledTaskInfo -TaskName $p.Task -ErrorAction Stop } catch { }
        $obs = @{
            probe = $p.Name; what = $p.What; task = $p.Task; principal = $p.Logon
            restart = '3/PT1M'; observedMinutes = $ProbeMinutes
            runsLogged = $(if ($null -ne $p.Log) { $runs } else { $null })
            lastTaskResult = $(if ($null -ne $info) { $info.LastTaskResult } else { $null })
            lastRunTime = $(if ($null -ne $info -and $null -ne $info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null })
            numberOfMissedRuns = $(if ($null -ne $info) { $info.NumberOfMissedRuns } else { $null })
            registrationError = $p.Error
            eventCount = @($events | Where-Object { $_.message -match [regex]::Escape($p.Task) }).Count
        }
        $observations += $obs
        Write-Log ("{0} ({1}): runsLogged={2} lastTaskResult={3} events={4}{5}" -f $p.Name, $p.What, $obs.runsLogged, $obs.lastTaskResult, $obs.eventCount, $(if ($p.Error) { " registrationError=$($p.Error)" } else { '' }))
        try { Unregister-ScheduledTask -TaskName $p.Task -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    }
    $result = @{
        probedAt = $startedAt.ToString('o'); build = [System.Environment]::OSVersion.VersionString
        observedMinutes = $ProbeMinutes; eventsNote = $eventsNote; probes = $observations; events = $events
    }
    ($result | ConvertTo-Json -Depth 6) | Set-Content -Path $ProbeResult -Encoding utf8
    Write-Log "wrote $ProbeResult"
}

# ---------------------------------------------------------------- status --

function Get-LastLogAge {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $last = Get-Content -Path $Path -Tail 1 -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($last)) { return $null }
    $stamp = $last.Substring(0, [Math]::Min(19, $last.Length))
    $when = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($stamp, 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$when)) { return $null }
    return @{ Age = [int]((Get-Date) - $when).TotalSeconds; Line = $last }
}

function Show-Recovery {
    Write-Output 'recovery'
    foreach ($kind in @('daemon', 'bridge')) {
        if ($kind -eq 'bridge' -and $NoBridge) { continue }
        $sup = Get-SupervisorProcess $kind
        $log = Get-SupervisorLog $kind
        $restarts = 0
        $lastRestart = ''
        if (Test-Path $log) {
            $lines = @(Get-Content -Path $log -ErrorAction SilentlyContinue | Where-Object { $_ -match ' restart n=' })
            $restarts = $lines.Count
            if ($restarts -gt 0) { $lastRestart = ($lines[-1] -split ' ', 2)[0] }
        }
        $state = if ($null -ne $sup) { "running pid=$($sup.ProcessId)" } else { 'absent' }
        Write-Output ("  {0,-8} supervisor {1} restarts={2}{3}" -f $kind, $state, $restarts, $(if ($lastRestart) { " last=$lastRestart" } else { '' }))
    }
    $tick = Get-LastLogAge $WatchdogLog
    if ($null -eq $tick) {
        Write-Output '  watchdog no tick recorded in this state directory'
    } else {
        Write-Output ("  watchdog last tick {0}s ago{1}" -f $tick.Age, $(if ($tick.Age -gt 300) { ' (STALE: more than 300s)' } else { '' }))
    }
    $task = Get-TaskOrNull $TaskDaemon
    $configured = if ($null -ne $task) { "$($task.Settings.RestartCount)/$($task.Settings.RestartInterval)" } else { 'no task' }
    if (Test-Path $ProbeResult) {
        try {
            $probe = Get-Content -Raw $ProbeResult | ConvertFrom-Json
            $parts = @($probe.probes | ForEach-Object {
                $runs = if ($null -ne $_.runsLogged) { "runs=$($_.runsLogged)" } else { "result=$($_.lastTaskResult)" }
                "$($_.probe) $($_.what): $runs events=$($_.eventCount)$(if ($_.registrationError) { ' (not registered)' } else { '' })"
            })
            Write-Output ("  scheduler restart-on-failure configured {0}; probe {1} over {2} min: {3}" -f $configured, $probe.probedAt.Substring(0, 10), $probe.observedMinutes, ($parts -join '; '))
        } catch {
            Write-Output "  scheduler restart-on-failure configured $configured; probe file unreadable: $ProbeResult"
        }
    } else {
        Write-Output "  scheduler restart-on-failure configured $configured; not probed on this box (run -Action probe-restart)"
    }
}

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
        $json = Get-HealthJson $port '/status'
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
    Show-Recovery
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
            if ($Restart -or -not (Test-Health $BridgePort '/health/live')) { $ok = (Start-Service 'bridge' $TaskBridge $BridgePort '/health/ready' 60) -and $ok } else { Write-Log 'bridge already healthy; left running (use -Restart to load the new build)' }
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
    'run' {
        if ($Service -eq '') { throw '-Action run needs -Service daemon or -Service bridge' }
        Invoke-Supervisor $Service
    }
    'probe-restart' { Invoke-RestartProbe }
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
        Write-Log "paused: the watchdog will report but not restart, and a supervisor exits after its next node exit (marker $PausedMarker)"
    }
    'resume' {
        if (Test-Path $PausedMarker) { Remove-Item $PausedMarker -Force }
        Write-Log 'resumed: the watchdog restarts again; a supervisor that exited is started by the watchdog on its next tick'
    }
}
