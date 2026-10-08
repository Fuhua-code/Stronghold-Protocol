@echo off
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  node "%ROOT%cli\build.mjs" build --profile connect --abis arm64-v8a
) else if /I "%~1"=="doctor" (
  shift
  node "%ROOT%cli\doctor.mjs" %*
) else if /I "%~1"=="bootstrap" (
  shift
  node "%ROOT%cli\bootstrap.mjs" %*
) else if /I "%~1"=="build" (
  shift
  node "%ROOT%cli\build.mjs" %*
) else if /I "%~1"=="verify" (
  shift
  node "%ROOT%cli\verify.mjs" %*
) else if /I "%~1"=="clean" (
  node "%ROOT%cli\clean.mjs"
) else (
  echo Unknown command "%~1". Use doctor, bootstrap, build, verify, or clean.
  exit /b 2
)
exit /b %ERRORLEVEL%
