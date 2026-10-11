# http-log tap, for Windows PowerShell 5.1 and PowerShell 7.
#
# The http-log mod puts one line before a command that may make web requests, which sets HTTPLOG_FILE (and, when its
# proxy runs, HTTPLOG_PROXY) and dot-sources this file. From then on, in that command and in any script it runs:
#   - Invoke-RestMethod and Invoke-WebRequest (and irm, iwr, curl in 5.1) write one JSON line per request to
#     HTTPLOG_FILE: method, url, body, status, duration and the response, then behave exactly as before;
#   - native programs the command starts (curl.exe, python, node, git) go through HTTPLOG_PROXY, which logs them.
# Nothing here changes a command's output or errors: a failure to log is swallowed.

$script:HttpLogFile = $env:HTTPLOG_FILE

if ($env:HTTPLOG_PROXY) {
    foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy') {
        Set-Item -Path "Env:$name" -Value $env:HTTPLOG_PROXY
    }
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    $env:no_proxy = $env:NO_PROXY

    # curl -i and -v print the proxy's own answer to a tunnel request as if it were part of the response. Asking it
    # not to keeps a command's output what it is without the proxy.
    $curl = Get-Command -Name 'curl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($curl) {
        $global:HttpLogCurl = $curl.Source
        Set-Item -Path 'Function:global:curl.exe' -Value { & $global:HttpLogCurl --suppress-connect-headers @args }
    }
}

function global:HttpLog-Append {
    param([string]$Json)
    if (-not $script:HttpLogFile) { return }
    try {
        $dir = [System.IO.Path]::GetDirectoryName($script:HttpLogFile)
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        [System.IO.File]::AppendAllText($script:HttpLogFile, $Json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# The body of each wrapper. Its `param` block is the cmdlet's own (ProxyCommand), so binding, positions, switches and
# a splatted hashtable behave exactly as for the cmdlet, and `$PSBoundParameters` says what was passed.
$script:HttpLogBody = @'
$__cmd = $global:HttpLogOriginals['__NAME__']
$__method = $null; $__uri = $null; $__sent = $null
if ($PSBoundParameters.ContainsKey('Uri')) { $__uri = "$($PSBoundParameters['Uri'])" }
if ($PSBoundParameters.ContainsKey('Method')) { $__method = "$($PSBoundParameters['Method'])" }
if ($PSBoundParameters.ContainsKey('Body')) { $__sent = $PSBoundParameters['Body'] }
$__clock = [System.Diagnostics.Stopwatch]::StartNew()
$__started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$__code = 0; $__text = ''; $__ok = $true; $__out = $null; $__result = $null; $__fault = $null
$__bound = $PSBoundParameters
try {
    if ($MyInvocation.ExpectingInput) { $input | & $__cmd @__bound | Tee-Object -Variable __out }
    else { & $__cmd @__bound | Tee-Object -Variable __out }
} catch {
    $__ok = $false
    $__fault = $_
}
$__clock.Stop()
# A `-SessionVariable` and its kin are set in the scope that called the cmdlet: which is this function's now
foreach ($__name in 'SessionVariable', 'StatusCodeVariable', 'ResponseHeadersVariable') {
    if ($PSBoundParameters.ContainsKey($__name)) {
        $__target = $PSBoundParameters[$__name]
        $__held = Get-Variable -Name $__target -Scope 0 -ErrorAction SilentlyContinue
        if ($__held) { Set-Variable -Name $__target -Scope 1 -Value $__held.Value }
    }
}
try {
    if ($__ok) {
        $__first = @($__out)[0]
        if ($__first -is [Microsoft.PowerShell.Commands.WebResponseObject]) {
            $__code = [int]$__first.StatusCode
            $__text = "$($__first.StatusDescription)"
            $__result = "$($__first.Content)"
        } elseif ($__first -is [string]) {
            $__result = (@($__out) -join "`n")
        } elseif ($null -ne $__first) {
            $__result = ($__out | ConvertTo-Json -Depth 8 -Compress)
        }
    } else {
        $__response = $__fault.Exception.Response
        if ($null -ne $__response) {
            $__code = [int]$__response.StatusCode
            $__text = "$($__response.StatusDescription)"
            if (-not $__text -and $__response.ReasonPhrase) { $__text = "$($__response.ReasonPhrase)" }
        }
        $__result = "$($__fault.ErrorDetails.Message)"
        if (-not $__result) { $__result = "$($__fault.Exception.Message)" }
    }
    if ($null -eq $__method) { $__method = if ($null -ne $__sent) { 'POST' } else { 'GET' } }
    $__bodyText = $null
    if ($null -ne $__sent) {
        $__bodyText = if ($__sent -is [string]) { $__sent } else { ($__sent | ConvertTo-Json -Depth 6 -Compress) }
    }
    if ($__uri) {
        HttpLog-Append (@{
            via = 'wrapper'; ts = $__started; method = $__method.ToUpper(); url = $__uri; code = $__code
            codeText = $__text; durationMs = [int]$__clock.ElapsedMilliseconds; ok = $__ok
            body = $__bodyText; result = $__result
        } | ConvertTo-Json -Compress -Depth 4)
    }
} catch { }
if (-not $__ok) { throw $__fault }
'@

# The cmdlets themselves, taken before a wrapper of the same name hides them (a script that is dot-sourced twice
# keeps the first, real ones)
if (-not $global:HttpLogOriginals) { $global:HttpLogOriginals = @{} }
foreach ($name in 'Invoke-RestMethod', 'Invoke-WebRequest') {
    if (-not $global:HttpLogOriginals[$name]) {
        $global:HttpLogOriginals[$name] = Get-Command -Name $name -CommandType Cmdlet
    }
}

foreach ($name in 'Invoke-RestMethod', 'Invoke-WebRequest') {
    $meta = New-Object System.Management.Automation.CommandMetadata $global:HttpLogOriginals[$name]
    $binding = [System.Management.Automation.ProxyCommand]::GetCmdletBindingAttribute($meta)
    $params = [System.Management.Automation.ProxyCommand]::GetParamBlock($meta)
    $text = "$binding`nparam(`n$params`n)`n" + $script:HttpLogBody.Replace('__NAME__', $name)
    Set-Item -Path "Function:global:$name" -Value ([scriptblock]::Create($text))
}
