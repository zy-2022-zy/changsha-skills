@echo off
setlocal
pushd "%~dp0.."
if errorlevel 1 exit /b 1
if exist "%~dp0..\runtime\node.exe" (
  "%~dp0..\runtime\node.exe" "%~dp0..\app\cli.js" %*
) else (
  call pnpm.cmd start -- %*
)
set "skillExitCode=%errorlevel%"
popd
exit /b %skillExitCode%
