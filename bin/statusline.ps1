# Stable native Windows launcher installed under the Claude config directory.
$ErrorActionPreference = 'SilentlyContinue'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $Utf8NoBom } catch {}
try { [Console]::OutputEncoding = $Utf8NoBom } catch {}
$OutputEncoding = $Utf8NoBom

$Runtime = Join-Path $PSScriptRoot 'runtime.mjs'
if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) {
    $Runtime = Join-Path (Split-Path -Parent $PSScriptRoot) 'core/statusline/runtime.mjs'
}
if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) { exit 0 }

$NodeBin = $env:CC_BOOTSTRAP_NODE_BIN
if (-not $NodeBin) { $NodeBin = $env:CLIPROXY_NODE_BIN }
$NodePathFile = Join-Path $PSScriptRoot '.node-path'
if (-not $NodeBin -and (Test-Path -LiteralPath $NodePathFile -PathType Leaf)) {
    $NodeBin = [IO.File]::ReadAllText($NodePathFile).Trim()
}
if (-not $NodeBin -or -not (Test-Path -LiteralPath $NodeBin -PathType Leaf)) {
    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($NodeCommand) { $NodeBin = $NodeCommand.Source }
}
if (-not $NodeBin) { exit 0 }

if (-not $env:COLUMNS) {
    try {
        $WindowWidth = [int]$Host.UI.RawUI.WindowSize.Width
        if ($WindowWidth -ge 20) { $env:COLUMNS = [string]$WindowWidth }
    } catch {
        # The Node runtime has a conservative fallback when no console width is available.
    }
}

$RawInput = [Console]::In.ReadToEnd()
$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = $NodeBin
$StartInfo.Arguments = '"' + $Runtime.Replace('"', '\"') + '"'
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$StartInfo.RedirectStandardInput = $true
$StartInfo.RedirectStandardOutput = $true
$StartInfo.RedirectStandardError = $true
foreach ($Property in @('StandardInputEncoding', 'StandardOutputEncoding', 'StandardErrorEncoding')) {
    try { $StartInfo.$Property = $Utf8NoBom } catch {}
}

$Process = New-Object System.Diagnostics.Process
$Process.StartInfo = $StartInfo
if (-not $Process.Start()) { exit 0 }
$Process.StandardInput.Write($RawInput)
$Process.StandardInput.Close()
$Output = $Process.StandardOutput.ReadToEnd()
$Errors = $Process.StandardError.ReadToEnd()
$Process.WaitForExit()

[Console]::Out.Write($Output)
if ($Errors) { [Console]::Error.Write($Errors) }
exit $Process.ExitCode
