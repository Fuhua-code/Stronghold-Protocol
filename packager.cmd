@echo off
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if "%~1"=="" (
  echo [workbench] checking local inputs...
  node "%ROOT%cli\doctor.mjs"
  if errorlevel 1 (
    echo.
    echo Workbench is not ready. Place the upstream source at the configured upstreamDir and prepare the local inputs.
    pause
    exit /b 1
  )
  if "!PACKAGER_STORE_PASSWORD!"=="" set /p "PACKAGER_STORE_PASSWORD=Keystore password: "
  if "!PACKAGER_KEY_PASSWORD!"=="" set "PACKAGER_KEY_PASSWORD=!PACKAGER_STORE_PASSWORD!"
  echo.
  echo [workbench] building connect-runtime...
  node "%ROOT%cli\build.mjs" build --profile connect-runtime --version-code auto --keep 3
  set "SP_EXIT=!ERRORLEVEL!"
  echo.
  pause
  exit /b !SP_EXIT!
)
if /I "%~1"=="workbench" (
  node "%ROOT%cli\doctor.mjs" %*
  if errorlevel 1 exit /b 1
  node "%ROOT%cli\build.mjs" build --profile connect-runtime --version-code auto %*
  exit /b !ERRORLEVEL!
) else if /I "%~1"=="doctor" (
  node "%ROOT%cli\doctor.mjs" %*
) else if /I "%~1"=="version" (
  node "%ROOT%cli\version.mjs" %*
) else if /I "%~1"=="bootstrap" (
  node "%ROOT%cli\bootstrap.mjs" %*
) else if /I "%~1"=="build" (
  node "%ROOT%cli\build.mjs" %*
) else if /I "%~1"=="verify" (
  node "%ROOT%cli\verify.mjs" %*
) else if /I "%~1"=="clean" (
  node "%ROOT%cli\clean.mjs"
) else (
  echo Unknown command "%~1". Use workbench, doctor, version, bootstrap, build, verify, or clean.
  exit /b 2
)
exit /b %ERRORLEVEL%
