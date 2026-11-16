# Windows worker scope (ADR 0032). Modes: keep <job>, run <job> <argv file>, terminate <job> <ms>,
# query <job>, probe. Only .NET calls, no cmdlets: `run` inherits the agent's environment, and a
# PowerShell 7 PSModulePath there would make Windows PowerShell autoload the wrong modules. The C#
# helper is compiled once per content hash into the temp directory (the controller's probe does it
# with a clean environment) and loaded from there.
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::Combine($PSScriptRoot, 'windows-worker-job.cs')
$sha = [Security.Cryptography.SHA256]::Create()
$hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-', '').Substring(0, 16)
$assembly = [IO.Path]::Combine([IO.Path]::GetTempPath(), "squawk-worker-job-$hash.dll")
if (-not [IO.File]::Exists($assembly)) {
  $partial = "$assembly.$PID.tmp"
  Add-Type -Path $source -OutputAssembly $partial -OutputType Library
  try { [IO.File]::Move($partial, $assembly) } catch { [IO.File]::Delete($partial) }
}
[void][Reflection.Assembly]::LoadFrom($assembly)
switch ($args[0]) {
  'keep' { [SquawkWorkerJob]::Keep($args[1]) }
  'run' {
    # The argv travels in a private file, NUL-separated, so its length is the command's own.
    $argv = [IO.File]::ReadAllText($args[2], [Text.Encoding]::UTF8).Split([char]0)
    [IO.File]::Delete($args[2])
    [Environment]::Exit([SquawkWorkerJob]::Run($args[1], $argv, 30000))
  }
  'terminate' { [SquawkWorkerJob]::Terminate($args[1], [int]$args[2]) }
  'query' { [SquawkWorkerJob]::Query($args[1]) }
  'probe' { [SquawkWorkerJob]::Probe() }
  default { throw 'Unknown worker job operation' }
}
