#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('check', 'setup', 'restore')]
    [string] $Action = 'check',

    [switch] $DryRun,
    [switch] $Yes,
    [string] $Backup,
    [string] $BootstrapHome,
    [string] $ConfigDir,
    [string] $Claude,
    [string] $Codex,
    [switch] $NoLegacyMigrate,
    [switch] $SkipUserPath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ExtraArgs
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bootstrap = Join-Path (Split-Path -Parent $scriptDir) 'core\bootstrap.mjs'
# Several node.exe copies can be on PATH; keep the first match so $nodePath stays a string.
$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue) |
    Select-Object -First 1
if ($null -eq $nodeCommand) {
    throw 'setup-windows.ps1: Node.js 18+ is required'
}
$nodePath = $nodeCommand.Path
# Windows PowerShell strips embedded double quotes from native-command arguments,
# so this expression must not contain any.
$nodeMajor = [int] (& $nodePath -p 'Number(process.versions.node.split(String.fromCharCode(46))[0])')
if ($nodeMajor -lt 18) {
    throw 'setup-windows.ps1: Node.js 18+ is required'
}

$homeDir = if ([string]::IsNullOrWhiteSpace($BootstrapHome)) {
    [Environment]::GetFolderPath('UserProfile')
} else {
    [IO.Path]::GetFullPath($BootstrapHome)
}
$configDirPath = if ([string]::IsNullOrWhiteSpace($ConfigDir)) {
    [IO.Path]::GetFullPath((Join-Path $homeDir '.claude'))
} else {
    [IO.Path]::GetFullPath($ConfigDir)
}
$binDir = [IO.Path]::GetFullPath((Join-Path $configDirPath 'bin'))
$stateFile = Join-Path $configDirPath 'portable-bootstrap\state.json'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$pathSnapshotName = 'windows-user-path.json'

foreach ($argument in @($ExtraArgs)) {
    if ($argument -match '^--(?:home|config-dir|profile|no-profile|external-change|dry-run|yes|backup|claude|codex|no-legacy-migrate)(?:=|$)') {
        throw "Use the native PowerShell parameters instead of passing $argument through ExtraArgs"
    }
}

function Test-PathEntry {
    param([AllowNull()][string] $PathValue, [string] $Entry)
    foreach ($part in @($PathValue -split ';')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        $candidate = $part.Trim().TrimEnd('\')
        if ([string]::Equals($candidate, $Entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Set-PathEntryPresence {
    param([string] $Entry, [bool] $Present)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $filtered = @($parts | Where-Object {
        -not [string]::Equals($_.Trim().TrimEnd('\'), $Entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($Present) { $next = @($Entry) + $filtered } else { $next = $filtered }
    [Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User')

    $processParts = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $processFiltered = @($processParts | Where-Object {
        -not [string]::Equals($_.Trim().TrimEnd('\'), $Entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($Present) { $env:Path = (@($Entry) + $processFiltered) -join ';' }
    else { $env:Path = $processFiltered -join ';' }
}

function New-CoreArguments {
    param([string] $CoreAction, [bool] $IncludeExternalPathChange)

    # Forward --config-dir only when the caller actually chose one. The core
    # treats the flag as "the user picked this directory" and pins
    # CLAUDE_CONFIG_DIR for every `claude mcp` call, which sends the
    # registration to <configDir>/.claude.json instead of the real ~/.claude.json
    # — a shadow entry that check reports as healthy but Claude Code never loads.
    $arguments = @($bootstrap, $CoreAction, '--no-profile', '--home', $homeDir)
    if (-not [string]::IsNullOrWhiteSpace($ConfigDir)) {
        $arguments += @('--config-dir', $configDirPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($Backup)) { $arguments += @('--backup', $Backup) }
    if (-not [string]::IsNullOrWhiteSpace($Claude)) { $arguments += @('--claude', $Claude) }
    if (-not [string]::IsNullOrWhiteSpace($Codex)) { $arguments += @('--codex', $Codex) }
    if ($NoLegacyMigrate) { $arguments += '--no-legacy-migrate' }
    if ($IncludeExternalPathChange) { $arguments += @('--external-change', 'Windows User PATH') }
    if ($null -ne $ExtraArgs) { $arguments += $ExtraArgs }
    return ,$arguments
}

function Invoke-Core {
    param([string[]] $Arguments)

    $lines = @(& $nodePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
    return [PSCustomObject]@{ ExitCode = $exitCode; Lines = @($lines) }
}

function Show-CoreResult {
    param($Result)
    foreach ($line in @($Result.Lines)) { [Console]::Out.WriteLine([string] $line) }
}

function Get-OutputId {
    param($Result, [string] $Prefix)
    foreach ($line in @($Result.Lines)) {
        if ([string] $line -match ('^' + [Regex]::Escape($Prefix) + '\s*(\S+)\s*$')) { return $Matches[1] }
    }
    return $null
}

function Get-BackupDirectory {
    param([string] $Id)
    if ($Id -notmatch '^[A-Za-z0-9._-]+$' -or $Id -eq '.' -or $Id -eq '..') {
        throw 'Invalid backup ID'
    }
    $root = [IO.Path]::GetFullPath((Join-Path $configDirPath 'portable-bootstrap\backups'))
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $Id))
    $parent = [IO.Directory]::GetParent($candidate)
    if ($null -eq $parent -or -not [string]::Equals(
        $parent.FullName.TrimEnd('\'),
        $root.TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Invalid backup ID'
    }
    return $candidate
}

function Write-PathSnapshot {
    param([string] $BackupId, [bool] $Present, [string] $Entry = $binDir)
    $directory = Get-BackupDirectory $BackupId
    $manifest = Join-Path $directory 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw "Backup manifest is missing for PATH snapshot: $BackupId"
    }
    $snapshot = @{ schemaVersion = 1; entry = $Entry; present = $Present }
    $snapshotFile = Join-Path $directory $pathSnapshotName
    [IO.File]::WriteAllText($snapshotFile, (($snapshot | ConvertTo-Json -Depth 3) + "`n"), $utf8NoBom)
}

function Read-PathSnapshot {
    param([string] $BackupId)
    $snapshotFile = Join-Path (Get-BackupDirectory $BackupId) $pathSnapshotName
    if (-not (Test-Path -LiteralPath $snapshotFile -PathType Leaf)) { return $null }
    $snapshot = Get-Content -LiteralPath $snapshotFile -Raw | ConvertFrom-Json
    if ($snapshot.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string] $snapshot.entry)) {
        throw "Invalid Windows PATH snapshot: $BackupId"
    }
    return $snapshot
}

function Resolve-RestoreBackupId {
    if (-not [string]::IsNullOrWhiteSpace($Backup)) { return $Backup }
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    return [string] $state.lastBackupId
}

function Confirm-WrapperApply {
    param([string] $Message)
    if ($Yes) { return $true }
    if (-not [Environment]::UserInteractive) { throw 'Confirmation required; rerun with -Yes after reviewing -DryRun output' }
    $answer = (Read-Host "$Message [y/N]").Trim().ToLowerInvariant()
    return ($answer -eq 'y' -or $answer -eq 'yes')
}

$userPath = if ($SkipUserPath) { $null } else { [Environment]::GetEnvironmentVariable('Path', 'User') }
$pathPresent = if ($SkipUserPath) { $true } else { Test-PathEntry $userPath $binDir }
$pathNeedsAdd = ($Action -eq 'setup' -and -not $SkipUserPath -and -not $pathPresent)
$coreArguments = New-CoreArguments $Action $pathNeedsAdd

if ($Action -eq 'check') {
    $result = Invoke-Core $coreArguments
    Show-CoreResult $result
    if ($SkipUserPath) { Write-Output '[info] Windows User PATH check skipped by request' }
    elseif ($pathPresent) { Write-Output "[ok] Windows User PATH contains $binDir" }
    else { Write-Output "[needs-setup] Windows User PATH is missing $binDir" }

    if ($result.ExitCode -eq 1) { exit 1 }
    if ($result.ExitCode -ne 0 -or -not $pathPresent) { exit 2 }
    exit 0
}

$restoreIdForPlan = $null
$snapshotForPlan = $null
$pathPlan = if ($Action -eq 'setup') {
    if ($SkipUserPath) { 'Windows User PATH: skipped by request' }
    elseif ($pathNeedsAdd) { "Windows User PATH: add $binDir" }
    else { "Windows User PATH: already contains $binDir" }
} else {
    if ($SkipUserPath) {
        'Windows User PATH: restore skipped by request'
    }
    else {
        $restoreIdForPlan = Resolve-RestoreBackupId
        $snapshotForPlan = if ([string]::IsNullOrWhiteSpace($restoreIdForPlan)) { $null } else { Read-PathSnapshot $restoreIdForPlan }
        if ([string]::IsNullOrWhiteSpace($Backup) -and -not [string]::IsNullOrWhiteSpace($restoreIdForPlan)) {
            $coreArguments += @('--backup', $restoreIdForPlan)
        }
        if ($null -eq $snapshotForPlan) { 'Windows User PATH: no change recorded for this backup' }
        elseif ([bool] $snapshotForPlan.present) { "Windows User PATH: ensure present: $($snapshotForPlan.entry)" }
        else { "Windows User PATH: ensure absent: $($snapshotForPlan.entry)" }
    }
}

if ($DryRun -or -not $Yes) {
    $previewArguments = @($coreArguments) + '--dry-run'
    $preview = Invoke-Core $previewArguments
    Show-CoreResult $preview
    Write-Output $pathPlan
    if ($preview.ExitCode -ne 0) { exit $preview.ExitCode }
    if ($DryRun) { exit 0 }
    if (-not (Confirm-WrapperApply "Apply this $Action plan?")) { throw 'Cancelled' }
}

$applyArguments = @($coreArguments) + '--yes'
$result = Invoke-Core $applyArguments
Show-CoreResult $result
if ($result.ExitCode -ne 0) { exit $result.ExitCode }

if ($Action -eq 'setup') {
    if ($pathNeedsAdd) {
        $setupBackupId = Get-OutputId $result 'Setup complete. Backup:'
        if ([string]::IsNullOrWhiteSpace($setupBackupId)) {
            throw 'Core setup did not return the backup ID required for Windows PATH rollback'
        }
        $setupPathWasPresent = Test-PathEntry ([Environment]::GetEnvironmentVariable('Path', 'User')) $binDir
        try {
            Write-PathSnapshot $setupBackupId $setupPathWasPresent
            if (-not $setupPathWasPresent) {
                Set-PathEntryPresence $binDir $true
            }
        }
        catch {
            try { Set-PathEntryPresence $binDir $setupPathWasPresent } catch {}
            $rollbackArguments = New-CoreArguments 'restore' $false
            $rollbackArguments += @('--backup', $setupBackupId, '--yes')
            $rollback = Invoke-Core $rollbackArguments
            if ($rollback.ExitCode -eq 0) {
                throw "Windows User PATH update failed; core setup was restored from $setupBackupId"
            }
            throw "Windows User PATH update failed and core rollback also failed; use backup $setupBackupId"
        }
        if ($setupPathWasPresent) {
            Write-Output "Windows User PATH became current before mutation: $binDir"
        }
        else {
            Write-Output "Windows User PATH added: $binDir"
        }
    }
    elseif (-not $SkipUserPath) {
        Write-Output "Windows User PATH already current: $binDir"
    }
    Write-Output 'Open a new terminal before invoking claudex.cmd.'
    exit 0
}

if ($SkipUserPath) {
    Write-Output 'Windows User PATH restore skipped by request'
    exit 0
}

$restoredBackupId = Get-OutputId $result 'Restore complete:'
$safetyBackupId = Get-OutputId $result 'Safety backup:'
$entry = $null
$wasPresent = $false
try {
    if ([string]::IsNullOrWhiteSpace($restoredBackupId)) {
        throw 'Core restore did not return the restored backup ID'
    }
    if ([string]::IsNullOrWhiteSpace($safetyBackupId)) {
        throw 'Core restore did not return the safety backup ID required for Windows PATH rollback'
    }
    if (-not [string]::IsNullOrWhiteSpace($restoreIdForPlan) -and -not [string]::Equals(
        $restoredBackupId,
        $restoreIdForPlan,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Core restored a different backup than the PATH snapshot plan'
    }

    $pathSnapshot = $snapshotForPlan
    if ($null -ne $pathSnapshot) {
        $entry = [string] $pathSnapshot.entry
        $wasPresent = Test-PathEntry ([Environment]::GetEnvironmentVariable('Path', 'User')) $entry
        Write-PathSnapshot $safetyBackupId $wasPresent $entry
        Set-PathEntryPresence $entry ([bool] $pathSnapshot.present)
        Write-Output "Windows User PATH restored for entry: $entry"
    }
    else {
        Write-Output 'Windows User PATH: no change recorded for restored backup'
    }
}
catch {
    if ($null -ne $entry) {
        try { Set-PathEntryPresence $entry $wasPresent } catch {}
    }
    if (-not [string]::IsNullOrWhiteSpace($safetyBackupId)) {
        $rollbackArguments = New-CoreArguments 'restore' $false
        $rollbackArguments += @('--backup', $safetyBackupId, '--yes')
        $rollback = Invoke-Core $rollbackArguments
        if ($rollback.ExitCode -eq 0) {
            throw "Windows User PATH restore failed; core restore was rolled back with $safetyBackupId"
        }
    }
    throw "Windows User PATH restore failed after core restore; use safety backup $safetyBackupId"
}

exit 0
