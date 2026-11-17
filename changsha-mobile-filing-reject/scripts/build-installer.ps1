param([string]$IsccPath, [switch]$TestPackage)
$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $skillRoot
try {
    if (-not $IsccPath) {
        $candidates = @()
        $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
        $registryRoots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $installations = Get-ItemProperty -Path $registryRoots -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'Inno Setup*' -and $_.InstallLocation } |
            Sort-Object DisplayVersion -Descending
        foreach ($installation in $installations) {
            $candidates += Join-Path $installation.InstallLocation 'ISCC.exe'
        }
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $IsccPath = $candidate; break }
        }
    }
    if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
        throw 'Inno Setup Compiler not found. Install Inno Setup or pass -IsccPath.'
    }
    & node (Join-Path $PSScriptRoot 'build-package.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Building the runtime payload failed.' }
    $package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $language = Join-Path (Split-Path -Parent $IsccPath) 'Languages\ChineseSimplified.isl'
    if (-not (Test-Path -LiteralPath $language)) {
        $language = Join-Path (Split-Path -Parent $IsccPath) 'Default.isl'
    }
    $dist = if ($TestPackage) { Join-Path $skillRoot 'build\installer-test-package' } else { Join-Path $skillRoot 'dist' }
    New-Item -Path $dist -ItemType Directory -Force | Out-Null
    Write-Output "Compiler: $IsccPath"
    $compilerArguments = @('/Q', "/DAppVersion=$($package.version)", "/DProductName=$($package.productName)", "/DPayloadDir=$(Join-Path $skillRoot 'build\workbuddy-payload')", "/DOutputPath=$dist", "/DLanguageFile=$language")
    if ($TestPackage) { $compilerArguments += '/DInstallerGuid=A521AB2B-2683-48AF-A051-2C251DFE06C4' }
    $compilerArguments += Join-Path $skillRoot 'packaging\workbuddy-installer.iss'
    & $IsccPath @compilerArguments
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
    $exe = Join-Path $dist "$($package.productName).exe"
    $stream = [System.IO.File]::OpenRead($exe)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    [System.IO.File]::WriteAllText("$exe.sha256", "$hash  $([System.IO.Path]::GetFileName($exe))`r`n", [System.Text.UTF8Encoding]::new($false))
    Get-Item -LiteralPath $exe | Select-Object FullName, Length | ConvertTo-Json
}
finally { Pop-Location }
