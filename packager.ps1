param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if (-not $Arguments -or $Arguments.Count -eq 0) { $Arguments = @('build', '--profile', 'connect', '--abis', 'arm64-v8a') }
  $command = $Arguments[0]
  if ($command -eq 'doctor') { $script = 'doctor.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'bootstrap') { $script = 'bootstrap.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'verify') { $script = 'verify.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'clean') { $script = 'clean.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'build') { $script = 'build.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  else { throw "Unknown command '$command'. Use doctor, bootstrap, build, verify, or clean." }
  & node (Join-Path $root (Join-Path 'cli' $script)) @rest
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
