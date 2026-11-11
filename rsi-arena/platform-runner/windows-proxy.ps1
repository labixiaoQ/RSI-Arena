# WSL transport through the Windows user's already enabled loopback proxy.
# Request JSON arrives on stdin. Credentials never appear in command arguments.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$client = $null
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  if ($settings.ProxyEnable -ne 1) { throw 'Windows proxy is not enabled' }
  $proxy = [string]$settings.ProxyServer
  if ($proxy -notmatch '^(127\.0\.0\.1|localhost):([0-9]{1,5})$') { throw 'Expected the existing Windows loopback proxy' }
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $handler.Proxy = New-Object System.Net.WebProxy(('http://' + $proxy))
  $handler.UseProxy = $true
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromMilliseconds([double]$request.timeoutMs)
  $method = New-Object System.Net.Http.HttpMethod([string]$request.method)
  $message = New-Object System.Net.Http.HttpRequestMessage($method, [Uri]$request.url)
  if ($null -ne $request.body) {
    $message.Content = New-Object System.Net.Http.StringContent([string]$request.body, [Text.Encoding]::UTF8, 'application/json')
  }
  foreach ($entry in $request.headers.psobject.Properties) {
    if ($entry.Name -ine 'Content-Type') { [void]$message.Headers.TryAddWithoutValidation($entry.Name,[string]$entry.Value) }
  }
  $response = $client.SendAsync($message).GetAwaiter().GetResult()
  $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  @{status=[int]$response.StatusCode;body=$content} | ConvertTo-Json -Compress -Depth 10
} catch {
  [Console]::Error.WriteLine('Windows proxy transport failed; request outcome may be unknown.')
  exit 1
} finally {
  if ($null -ne $client) { $client.Dispose() }
}
