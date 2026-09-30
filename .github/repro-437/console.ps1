# Runs inside a real console window. Starts portless sharing this console,
# ends it via $Mode, and records process + console-mode state.
param([string]$Cli, [string]$Out, [string]$Mode, [int]$AppPort, [string]$Shape = "single")
$ErrorActionPreference = "Stop"
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
'@
function ConMode { $h = [W.K]::GetStdHandle(-10); $m = [uint32]0; [void][W.K]::GetConsoleMode($h, [ref]$m); '0x{0:X}' -f $m }
function Rec($k, $v) { "$k=$v" | Out-File -Append -Encoding ascii "$Out\result.txt" }

Remove-Item Env:CI -ErrorAction SilentlyContinue
$env:REPRO_OUT = $Out
if ($Mode -eq "graceful") { $env:DEV_EXIT_AFTER_MS = "6000" }
Rec "mode_before" (ConMode)

$dev = Join-Path $PSScriptRoot "dev.cjs"
if ($Shape -eq "single") {
  $p = Start-Process -FilePath node -ArgumentList "`"$Cli`"", "demo", "--app-port", "$AppPort", "node", "`"$dev`"" -NoNewWindow -PassThru -RedirectStandardOutput "$Out\portless.out" -RedirectStandardError "$Out\portless.err"
} else {
  # Workspace root with one app: turbo.json selects turbo mode, "turbo": false
  # selects direct multi-app spawning. The workspace is prepared by the job.
  $ws = $env:REPRO_WS
  $p = Start-Process -FilePath node -ArgumentList "`"$Cli`"" -WorkingDirectory $ws -NoNewWindow -PassThru -RedirectStandardOutput "$Out\portless.out" -RedirectStandardError "$Out\portless.err"
}
Rec "portless_pid" $p.Id
for ($i = 0; $i -lt 120 -and -not (Test-Path "$Out\dev.pid"); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path "$Out\dev.pid")) { Rec "error" "dev server never started"; exit 1 }
$devPid = [int](Get-Content "$Out\dev.pid")
Rec "dev_pid" $devPid
Rec "mode_running" (ConMode)
Get-CimInstance Win32_Process | Where-Object { $_.Name -in "node.exe","cmd.exe","turbo.exe" } | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List | Out-File -Encoding ascii "$Out\procs-running.txt"

if ($Mode -eq "forcekill") {
  taskkill /F /PID $p.Id | Out-Null
} else {
  $p.WaitForExit(30000) | Out-Null
}
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process | Where-Object { $_.Name -in "node.exe","cmd.exe","turbo.exe" } | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List | Out-File -Encoding ascii "$Out\procs-after.txt"
Rec "portless_alive" ([bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue))
Rec "dev_alive" ([bool](Get-Process -Id $devPid -ErrorAction SilentlyContinue))
Rec "turbo_procs" (@(Get-Process turbo -ErrorAction SilentlyContinue).Count)
Rec "app_port_listening" ([bool](Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue))
Rec "mode_after" (ConMode)
Rec "ready" "1"
