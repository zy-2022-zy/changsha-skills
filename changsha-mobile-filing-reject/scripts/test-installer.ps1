param([string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $skillRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $InstallerPath) {
    # Use a separate registration so the real installed skill is never overwritten.
    & (Join-Path $PSScriptRoot 'build-installer.ps1') -TestPackage
    if ($LASTEXITCODE -ne 0) { throw 'Building the test installer failed.' }
    $InstallerPath = Join-Path $skillRoot "build\installer-test-package\$($package.productName).exe"
    $appGuid = 'A521AB2B-2683-48AF-A051-2C251DFE06C4'
} else {
    $appGuid = '698B8D5D-96AF-4B7F-A7AA-2F82C34B8BDD'
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw 'Build the installer first.' }

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + $appGuid + '}_is1'
if (Test-Path -LiteralPath $uninstallKey) {
    throw 'The application is already registered. Do not overwrite a real installation during testing.'
}
$testRoot = Join-Path $skillRoot ('build\installer-smoke-' + [Guid]::NewGuid().ToString('N'))
$skillsRoot = Join-Path $testRoot ('WorkBuddy skills ' + [char]0x4E2D + [char]0x6587 + ' with spaces')
$legacyDir = Join-Path $skillsRoot 'changsha-mobile-filing-reject'
$skillDir = Join-Path $skillsRoot $package.productName
$downloadDir = Join-Path $testRoot ('downloads\' + [char]0x96C6 + [char]0x56E2 + [char]0x9A73 + [char]0x56DE)
New-Item -Path $testRoot -ItemType Directory -Force | Out-Null
$installed = $false
function Get-ContentHash([string]$FileName) {
    $stream = [System.IO.File]::OpenRead($FileName)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
}
function Run-Installer([string]$LogName, [string]$Destination) {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
        ('/DIR="' + $Destination + '"'), ('/DownloadDir="' + $downloadDir + '"'),
        ('/LOG="' + (Join-Path $testRoot $LogName) + '"'))
    $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode). See $LogName." }
}
try {
    Run-Installer 'install.log' $legacyDir
    $installed = $true
    if (-not (Test-Path -LiteralPath $downloadDir -PathType Container)) { throw 'Download directory was not created.' }
    $node = Join-Path $legacyDir 'runtime\node.exe'
    & $node (Join-Path $PSScriptRoot 'verify-installed.mjs') $legacyDir (Join-Path $testRoot 'fixtures with spaces')
    if ($LASTEXITCODE -ne 0) { throw 'The installed runtime verification failed.' }

    # Upgrade must preserve exact configuration and generated runtime data.
    $configPath = Join-Path $legacyDir '.env'
    [System.IO.File]::AppendAllText($configPath, "# upgrade-preservation-check`r`n", [System.Text.Encoding]::UTF8)
    $beforeHash = Get-ContentHash $configPath
    New-Item -Path (Join-Path $legacyDir '.runtime'), (Join-Path $legacyDir 'reports') -ItemType Directory -Force | Out-Null
    $authPath = Join-Path $legacyDir '.runtime\preserve-test.txt'
    $statePath = Join-Path $legacyDir 'reports\preserve-test.txt'
    [System.IO.File]::WriteAllText($authPath, 'synthetic-cache-no-secrets')
    [System.IO.File]::WriteAllText($statePath, 'synthetic-batch-no-production')
    Run-Installer 'upgrade.log' $skillDir
    if (Test-Path -LiteralPath $legacyDir) { throw 'Upgrade left the old English skill directory in place.' }
    $configPath = Join-Path $skillDir '.env'
    $authPath = Join-Path $skillDir '.runtime\preserve-test.txt'
    $statePath = Join-Path $skillDir 'reports\preserve-test.txt'
    if ((Get-ContentHash $configPath) -ne $beforeHash) { throw 'Upgrade replaced .env.' }
    foreach ($file in @($authPath, $statePath)) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Upgrade removed $file" }
    }
    $node = Join-Path $skillDir 'runtime\node.exe'
    & $node (Join-Path $PSScriptRoot 'verify-installed.mjs') $skillDir (Join-Path $testRoot 'migrated fixtures') '--allow-state'
    if ($LASTEXITCODE -ne 0) { throw 'The migrated runtime verification failed.' }
    Run-Installer 'repeat-upgrade.log' $skillDir
    if ((Get-ContentHash $configPath) -ne $beforeHash) { throw 'Repeated upgrade replaced .env.' }
    $registered = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registered.InstallLocation.TrimEnd('\') -ne $skillDir) { throw 'Uninstall registration still points at the old directory.' }
    $uninstaller = Join-Path $skillDir 'unins000.exe'
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $testRoot 'uninstall.log') + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) { throw 'Uninstaller failed.' }
    $installed = $false
    if (Test-Path -LiteralPath (Join-Path $skillDir 'SKILL.md')) { throw 'Uninstall left the active skill installed.' }
    foreach ($file in @($configPath, $authPath, $statePath)) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Uninstall removed user data: $file" }
    }
    if (-not (Test-Path -LiteralPath $downloadDir)) { throw 'Uninstall removed the downloads directory.' }
    [PSCustomObject]@{ TestRoot = $testRoot; FreshInstall = 'passed'; ChineseDirectoryMigration = 'passed'; RepeatUpgrade = 'passed'; Uninstall = 'passed'; UserDataPreserved = $true } | ConvertTo-Json
}
finally {
    if ($installed) {
        foreach ($candidateDir in @($skillDir, $legacyDir)) {
            $uninstaller = Join-Path $candidateDir 'unins000.exe'
            if (Test-Path -LiteralPath $uninstaller) {
                Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait | Out-Null
                break
            }
        }
    }
}
