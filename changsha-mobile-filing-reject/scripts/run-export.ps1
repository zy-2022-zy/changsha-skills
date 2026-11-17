param(
    [string]$Date,
    [string]$Start,
    [string]$End,
    [string]$BatchId,
    [switch]$Execute,
    [switch]$Results
)
$ErrorActionPreference = 'Stop'
$skillDirectory = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $skillDirectory
try {
    $command = if ($Results) { 'results' } else { 'export' }
    $cliArguments = @($command)
    if ($Date) { $cliArguments += @('--date', $Date) }
    if ($Start) { $cliArguments += @('--start', $Start) }
    if ($End) { $cliArguments += @('--end', $End) }
    if ($BatchId) { $cliArguments += @('--batch-id', $BatchId) }
    if ($Execute) { $cliArguments += '--execute' }
    & (Join-Path $PSScriptRoot 'run.cmd') @cliArguments
    if ($LASTEXITCODE -ne 0) { throw "导出工具退出，代码：$LASTEXITCODE" }
}
finally { Pop-Location }
