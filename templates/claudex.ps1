#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ForwardArgs
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Set-PSDebug -Off

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

function Get-FastExtraBody {
    param([AllowEmptyString()][string] $Existing)

    $body = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($Existing)) {
        try {
            $parsed = ConvertFrom-Json -InputObject $Existing -ErrorAction Stop
        }
        catch {
            throw [FormatException]::new('CLAUDE_CODE_EXTRA_BODY is not valid JSON')
        }
        if (($null -eq $parsed) -or
            ($parsed -isnot [System.Management.Automation.PSCustomObject])) {
            throw [FormatException]::new('CLAUDE_CODE_EXTRA_BODY is not a JSON object')
        }
        foreach ($property in $parsed.PSObject.Properties) {
            $body[$property.Name] = $property.Value
        }
    }
    $body['speed'] = 'fast'
    return (ConvertTo-Json -InputObject $body -Compress -Depth 100)
}

$homeDir = [Environment]::GetFolderPath('UserProfile')
$keyFile = Get-EnvOrDefault 'CLAUDEX_API_KEY_FILE' (Join-Path $homeDir '.secrets\cliproxy_apikey')
$preferredUrl = Get-EnvOrDefault 'CLIPROXY_URL' 'http://127.0.0.1:8317'
$fallbackUrl = Get-EnvOrDefault 'CLAUDEX_FALLBACK_URL' 'http://127.0.0.1:8317'
$claudeBin = Get-EnvOrDefault 'CLAUDEX_CLAUDE_BIN' 'claude'
$checkOnly = $false
$fastMode = $false
$parseLauncherOptions = $true
[string[]] $claudeArgs = @()
foreach ($argument in @($ForwardArgs)) {
    if ($parseLauncherOptions -and $argument -eq '--check') {
        $checkOnly = $true
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--fast') {
        $fastMode = $true
        continue
    }
    if ($parseLauncherOptions -and $argument -eq '--') {
        $parseLauncherOptions = $false
        continue
    }
    $parseLauncherOptions = $false
    $claudeArgs += $argument
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

$claudeCommand = Get-Command $claudeBin -CommandType Application,ExternalScript -ErrorAction SilentlyContinue
if ($null -eq $claudeCommand) {
    [Console]::Error.WriteLine('claudex: Claude executable not found')
    exit 1
}

$fastExtraBody = $null
if ($fastMode) {
    try {
        $fastExtraBody = Get-FastExtraBody ([Environment]::GetEnvironmentVariable('CLAUDE_CODE_EXTRA_BODY', 'Process'))
    }
    catch {
        [Console]::Error.WriteLine('claudex: CLAUDE_CODE_EXTRA_BODY must be a JSON object when --fast is used')
        exit 1
    }
}

if ($checkOnly) {
    [Console]::Out.WriteLine('claudex check: secret file present and non-empty (value hidden)')
    [Console]::Out.WriteLine("claudex check: $selectedLabel endpoint returned HTTP 2xx")
    [Console]::Out.WriteLine('claudex check: Claude executable found')
    [Console]::Out.WriteLine('claudex check: inherited ANTHROPIC_API_KEY will be removed before launch')
    if ($fastMode) {
        [Console]::Out.WriteLine('claudex check: Fast mode enabled (request speed=fast)')
    }
    else {
        [Console]::Out.WriteLine('claudex check: Fast mode available via --fast')
    }
    exit 0
}

$names = @(
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_EXTRA_BODY',
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
    if ($fastMode) {
        $env:CLAUDE_CODE_EXTRA_BODY = $fastExtraBody
    }
    $env:CLAUDE_CODE_SUBAGENT_MODEL = 'gpt-5.6-sol'
    $env:CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '3'
    $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '360000'
    $env:ENABLE_TOOL_SEARCH = 'false'

    & $claudeCommand.Path '--permission-mode' 'auto' '--model' 'gpt-5.6-sol[1m]' @claudeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    $apiKey = $null
}

exit $exitCode
