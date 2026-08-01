#Requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $ForwardArgsBase64,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ForwardArgs
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Set-PSDebug -Off

if (-not [string]::IsNullOrWhiteSpace($ForwardArgsBase64)) {
    try {
        $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ForwardArgsBase64))
        $payload = ConvertFrom-Json -InputObject $payloadJson -ErrorAction Stop
        if (($null -eq $payload) -or
            ($payload -isnot [System.Management.Automation.PSCustomObject]) -or
            ([int] $payload.version -ne 1) -or
            ($null -eq $payload.PSObject.Properties['args'])) {
            throw [FormatException]::new('invalid encoded argument payload')
        }
        $decodedArgs = @($payload.args)
        foreach ($item in $decodedArgs) {
            if ($item -isnot [string]) {
                throw [FormatException]::new('invalid encoded argument payload')
            }
        }
        [string[]] $ForwardArgs = $decodedArgs
    }
    catch {
        [Console]::Error.WriteLine('claudex: invalid internal encoded argument payload')
        exit 1
    }
}

function Get-EnvOrDefault {
    param([string] $Name, [string] $Default)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

function Test-ProxyEndpoint {
    param([string] $BaseUrl, [string] $ApiKey)

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $request = $null
    $response = $null
    try {
        $client.Timeout = [TimeSpan]::FromSeconds(3)
        $endpoint = $BaseUrl.TrimEnd('/') + '/v1/models'
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $endpoint)
        $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $ApiKey)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $code = [int] $response.StatusCode
        return ($code -ge 200 -and $code -lt 300)
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

function Test-SameEndpoint {
    param([string] $Left, [string] $Right)
    return [string]::Equals($Left.TrimEnd('/'), $Right.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)
}

$homeDir = [Environment]::GetFolderPath('UserProfile')
$keyFile = Get-EnvOrDefault 'CLAUDEX_API_KEY_FILE' (Join-Path $homeDir '.secrets\cliproxy_apikey')
$preferredUrl = Get-EnvOrDefault 'CLIPROXY_URL' 'http://127.0.0.1:8317'
$fallbackUrl = Get-EnvOrDefault 'CLAUDEX_FALLBACK_URL' 'http://127.0.0.1:8317'
$claudeBin = Get-EnvOrDefault 'CLAUDEX_CLAUDE_BIN' 'claude'
$nodeBin = Get-EnvOrDefault 'CLAUDEX_NODE_BIN' 'node'
$checkOnly = $false
$tierRequest = 'inherit'
$modelFamily = 'sol'
$effort = 'xhigh'
$expectModelValue = $false
$expectEffortValue = $false
$parseLauncherOptions = $true
[string[]] $claudeArgs = @()
foreach ($argument in @($ForwardArgs)) {
    if ($parseLauncherOptions -and $expectModelValue) {
        $modelFamily = $argument
        $expectModelValue = $false
        continue
    }
    if ($parseLauncherOptions -and $expectEffortValue) {
        $effort = $argument
        $expectEffortValue = $false
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--check') {
        $checkOnly = $true
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--fast') {
        $tierRequest = 'fast'
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--standard') {
        $tierRequest = 'standard'
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--gpt-model') {
        $expectModelValue = $true
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--effort') {
        $expectEffortValue = $true
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--') {
        $parseLauncherOptions = $false
        continue
    }
    $parseLauncherOptions = $false
    $claudeArgs += $argument
}

if ($expectModelValue) {
    [Console]::Error.WriteLine('claudex: --gpt-model requires a value (sol|luna|terra)')
    exit 1
}
if ($expectEffortValue) {
    [Console]::Error.WriteLine('claudex: --effort requires a value (high|xhigh|max|ultra)')
    exit 1
}
$modelFamily = $modelFamily.ToLowerInvariant()
$effort = $effort.ToLowerInvariant()
if ($effort -notin @('high', 'xhigh', 'max', 'ultra')) {
    [Console]::Error.WriteLine("claudex: invalid --effort value $effort (expected high|xhigh|max|ultra)")
    exit 1
}

switch ($modelFamily) {
    'sol' { $modelId = 'gpt-5.6-sol' }
    'luna' {
        if ($effort -eq 'ultra') {
            [Console]::Error.WriteLine('claudex: gpt-5.6-luna does not support effort ultra (expected high|xhigh|max)')
            exit 1
        }
        $modelId = 'gpt-5.6-luna'
    }
    'terra' { $modelId = 'gpt-5.6-terra' }
    default {
        [Console]::Error.WriteLine("claudex: invalid --gpt-model value $modelFamily (expected sol|luna|terra)")
        exit 1
    }
}

# The proxy strips the "(effort)" suffix and writes reasoning.effort upstream;
# Claude Code strips the trailing "[1m]" client-side before sending, so the
# combined form keeps the 1M context budget AND selects the reasoning tier.
$mainModel = "$modelId($effort)[1m]"
$subagentModel = "$modelId($effort)"
$nodeCommand = Get-Command $nodeBin -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
    [Console]::Error.WriteLine('claudex: Node.js 18+ is required')
    exit 1
}
$execHelper = Join-Path $PSScriptRoot 'claudex-exec.mjs'
if (-not (Test-Path -LiteralPath $execHelper -PathType Leaf)) {
    [Console]::Error.WriteLine('claudex: claudex-exec.mjs is missing; rerun bootstrap setup')
    exit 1
}

$inheritedTier = [Environment]::GetEnvironmentVariable('CLAUDEX_DELEGATION_TIER', 'Process')
& $nodeCommand.Path $execHelper --has-fast-extra-body
$inheritedBodyFast = ($LASTEXITCODE -eq 0)
if (($LASTEXITCODE -ne 0) -and ($LASTEXITCODE -ne 1)) {
    [Console]::Error.WriteLine('claudex: unable to inspect CLAUDE_CODE_EXTRA_BODY safely')
    exit 1
}
if ($tierRequest -eq 'fast') {
    $effectiveTier = 'fast'
    $tierSource = 'explicit'
}
elseif ($tierRequest -eq 'standard') {
    $effectiveTier = 'standard'
    $tierSource = 'explicit'
}
elseif ([string]::Equals($inheritedTier, 'fast', [StringComparison]::Ordinal)) {
    $effectiveTier = 'fast'
    $tierSource = 'inherited marker'
}
elseif ($inheritedBodyFast) {
    $effectiveTier = 'fast'
    $tierSource = 'inherited request body'
}
else {
    $effectiveTier = 'standard'
    $tierSource = 'default'
}

$extraBodyAction = $null
if ($effectiveTier -eq 'fast') {
    $extraBodyAction = 'fast'
}
elseif ($tierRequest -eq 'standard') {
    $extraBodyAction = 'standard'
}
if ($null -ne $extraBodyAction) {
    & $nodeCommand.Path $execHelper --validate-extra-body-update $extraBodyAction
    if ($LASTEXITCODE -ne 0) {
        if ($extraBodyAction -eq 'fast') {
            [Console]::Error.WriteLine('claudex: CLAUDE_CODE_EXTRA_BODY must be a JSON object when Fast is effective')
        }
        else {
            [Console]::Error.WriteLine('claudex: CLAUDE_CODE_EXTRA_BODY must be a JSON object when --standard is used')
        }
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    [Console]::Error.WriteLine('claudex: secret file is missing or empty; create ~/.secrets/cliproxy_apikey yourself')
    exit 1
}

$apiKey = [IO.File]::ReadAllText($keyFile).Trim()
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    [Console]::Error.WriteLine('claudex: secret file is missing or empty; create ~/.secrets/cliproxy_apikey yourself')
    exit 1
}

$selectedUrl = $null
$selectedLabel = $null
if (Test-ProxyEndpoint $preferredUrl $apiKey) {
    $selectedUrl = $preferredUrl
    $selectedLabel = 'preferred'
}
elseif ((-not (Test-SameEndpoint $preferredUrl $fallbackUrl)) -and (Test-ProxyEndpoint $fallbackUrl $apiKey)) {
    $selectedUrl = $fallbackUrl
    $selectedLabel = 'localhost fallback'
}
else {
    [Console]::Error.WriteLine('claudex: no healthy proxy endpoint returned HTTP 2xx; refusing to launch')
    exit 1
}

$claudeCommand = Get-Command $claudeBin -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $claudeCommand) {
    [Console]::Error.WriteLine('claudex: native Claude executable or command shim not found')
    exit 1
}

if ($checkOnly) {
    [Console]::Out.WriteLine('claudex check: secret file present and non-empty (value hidden)')
    [Console]::Out.WriteLine("claudex check: $selectedLabel endpoint returned HTTP 2xx")
    [Console]::Out.WriteLine('claudex check: Claude executable found')
    [Console]::Out.WriteLine('claudex check: inherited ANTHROPIC_API_KEY will be removed before launch')
    [Console]::Out.WriteLine("claudex check: delegation tier=$effectiveTier ($tierSource)")
    if ($effectiveTier -eq 'fast') {
        [Console]::Out.WriteLine('claudex check: Fast mode enabled (request speed=fast, downstream delegation defaults Fast)')
    }
    else {
        [Console]::Out.WriteLine('claudex check: Fast mode available via --fast')
    }
    [Console]::Out.WriteLine("claudex check: GPT model=$modelFamily, reasoning effort=$effort (model $mainModel)")
    exit 0
}

$names = @(
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_EXTRA_BODY',
    'CLAUDEX_EXTRA_BODY_ACTION',
    'CLAUDEX_DELEGATION_TIER',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'ENABLE_TOOL_SEARCH'
)
$previous = @{}
foreach ($name in $names) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'Process')
    $env:ANTHROPIC_BASE_URL = $selectedUrl
    $env:ANTHROPIC_AUTH_TOKEN = $apiKey
    if ($null -ne $extraBodyAction) {
        $env:CLAUDEX_EXTRA_BODY_ACTION = $extraBodyAction
    }
    else {
        [Environment]::SetEnvironmentVariable('CLAUDEX_EXTRA_BODY_ACTION', $null, 'Process')
    }
    if ($effectiveTier -eq 'fast') {
        $env:CLAUDEX_DELEGATION_TIER = 'fast'
    }
    else {
        [Environment]::SetEnvironmentVariable('CLAUDEX_DELEGATION_TIER', $null, 'Process')
    }
    $env:CLAUDE_CODE_SUBAGENT_MODEL = $subagentModel
    $env:CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '3'
    $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '360000'
    $env:ENABLE_TOOL_SEARCH = 'false'

    & $nodeCommand.Path $execHelper $claudeCommand.Path $mainModel @claudeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    $apiKey = $null
}

exit $exitCode
