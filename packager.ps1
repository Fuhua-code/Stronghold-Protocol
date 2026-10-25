param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if (-not $Arguments -or $Arguments.Count -eq 0) { $Arguments = @('workbench') }
  $command = $Arguments[0]
  if ($command -eq 'workbench') { $script = $null; $rest = @() }
  elseif ($command -eq 'doctor') { $script = 'doctor.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'version') { $script = 'version.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'bootstrap') { $script = 'bootstrap.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'verify') { $script = 'verify.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'clean') { $script = 'clean.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  elseif ($command -eq 'build') { $script = 'build.mjs'; $rest = @($Arguments | Select-Object -Skip 1) }
  else { throw "Unknown command '$command'. Use workbench, doctor, version, bootstrap, build, verify, or clean." }
  if ($command -eq 'workbench') {
    & node (Join-Path $root 'cli\doctor.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node (Join-Path $root 'cli\build.mjs') build --profile connect-runtime --version-code auto @rest
  } else {
    & node (Join-Path $root (Join-Path 'cli' $script)) @rest
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
