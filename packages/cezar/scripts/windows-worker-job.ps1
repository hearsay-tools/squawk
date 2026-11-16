# Windows worker scope (ADR 0032). Modes: keep <job>, run <job> <base64 JSON argv>, terminate <job> <ms>,
# query <job>, probe. The C# helper is compiled once per content hash into the user's temp directory.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'windows-worker-job.cs'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.Substring(0, 16)
$assembly = Join-Path ([IO.Path]::GetTempPath()) "squawk-worker-job-$hash.dll"
if (-not (Test-Path -LiteralPath $assembly)) {
  $partial = "$assembly.$PID.tmp"
  Add-Type -Path $source -OutputAssembly $partial -OutputType Library
  try { Move-Item -LiteralPath $partial -Destination $assembly -ErrorAction Stop } catch { Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue }
}
Add-Type -Path $assembly
switch ($args[0]) {
  'keep' { [SquawkWorkerJob]::Keep($args[1]) }
  'run' {
    $argv = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[2])) | ConvertFrom-Json
    [Environment]::Exit([SquawkWorkerJob]::Run($args[1], [string[]]$argv, 30000))
  }
  'terminate' { [SquawkWorkerJob]::Terminate($args[1], [int]$args[2]) }
  'query' { [SquawkWorkerJob]::Query($args[1]) }
  'probe' { [SquawkWorkerJob]::Probe() }
  default { throw 'Unknown worker job operation' }
}
