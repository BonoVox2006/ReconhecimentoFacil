# Local HTTP server + Camara deputy photo proxy. No Node.js, no admin.
# Uses PowerShell and .NET (TcpListener on 127.0.0.1).

$ErrorActionPreference = "Stop"

# Deputy photos are HTTPS; older .NET defaults may block TLS 1.2.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
catch { }

$Port = if ($env:PORT) { [int]$env:PORT } else { 3847 }

$ScriptDir = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  $PSScriptRoot
}
else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}
$PublicRoot = Join-Path $ScriptDir "public"
$AllowedPrefix = "https://www.camara.leg.br/internet/deputado/bandep/"

function Get-QueryUrlParam([string]$query) {
  if (-not $query) { return $null }
  foreach ($p in ($query -split "&")) {
    $eq = $p.IndexOf("=")
    if ($eq -lt 0) { continue }
    $k = $p.Substring(0, $eq)
    if ($k -ne "url") { continue }
    $v = $p.Substring($eq + 1)
    return [System.Uri]::UnescapeDataString($v)
  }
  return $null
}

# Browsers may send "GET http://host:port/path?x=1 HTTP/1.1" (absolute form).
function Split-RequestTarget([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @{ Path = "/"; Query = "" }
  }
  $t = $raw.Trim()
  if ($t.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase) -or $t.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    try {
      $u = [System.Uri]::new($t)
      $path = $u.AbsolutePath
      if ([string]::IsNullOrEmpty($path)) { $path = "/" }
      $q = ""
      if ($u.Query.Length -gt 1) {
        $q = $u.Query.Substring(1)
      }
      return @{ Path = $path; Query = $q }
    }
    catch {
      return @{ Path = "/"; Query = "" }
    }
  }
  $qi = $t.IndexOf("?")
  $path = if ($qi -ge 0) { $t.Substring(0, $qi) } else { $t }
  $q = if ($qi -ge 0) { $t.Substring($qi + 1) } else { "" }
  return @{ Path = $path; Query = $q }
}

function Get-ContentType([string]$ext) {
  switch ($ext.ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".js" { return "application/javascript; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".svg" { return "image/svg+xml" }
    ".webmanifest" { return "application/manifest+json" }
    default { return "application/octet-stream" }
  }
}

function Read-HttpRequestHeaders([System.Net.Sockets.NetworkStream]$stream) {
  $acc = New-Object System.IO.MemoryStream
  $chunk = New-Object byte[] 2048
  $max = 65536
  $done = $false
  while ($acc.Length -lt $max -and -not $done) {
    $n = $stream.Read($chunk, 0, $chunk.Length)
    if ($n -le 0) { break }
    $acc.Write($chunk, 0, $n)
    $a = $acc.ToArray()
    for ($j = 0; $j -le $a.Length - 4; $j++) {
      if ($a[$j] -eq 13 -and $a[$j + 1] -eq 10 -and $a[$j + 2] -eq 13 -and $a[$j + 3] -eq 10) {
        $done = $true
        break
      }
    }
    if (-not $done) {
      for ($k = 0; $k -le $a.Length - 2; $k++) {
        if ($a[$k] -eq 10 -and $a[$k + 1] -eq 10) {
          $done = $true
          break
        }
      }
    }
  }
  if ($acc.Length -eq 0) { return $null }
  $text = [System.Text.Encoding]::ASCII.GetString($acc.ToArray())
  $headerEnd = $text.IndexOf("`r`n`r`n")
  if ($headerEnd -ge 0) {
    $headerOnly = $text.Substring(0, $headerEnd)
  }
  else {
    $headerEnd = $text.IndexOf("`n`n")
    if ($headerEnd -ge 0) {
      $headerOnly = $text.Substring(0, $headerEnd)
    }
    else {
      $headerOnly = $text
    }
  }
  $firstLineEnd = $headerOnly.IndexOf("`r`n")
  if ($firstLineEnd -lt 0) { $firstLineEnd = $headerOnly.IndexOf("`n") }
  if ($firstLineEnd -lt 0) {
    $first = $headerOnly.Trim()
  }
  else {
    $first = $headerOnly.Substring(0, $firstLineEnd)
  }
  if ([string]::IsNullOrWhiteSpace($first)) { return $null }
  $parts = $first -split "\s+", 3
  if ($parts.Count -lt 2) { return $null }
  return @{
    Method = $parts[0]
    RawPath = $parts[1]
  }
}

function Send-Response(
  [System.Net.Sockets.NetworkStream]$stream,
  [int]$code,
  [string]$reason,
  [hashtable]$extraHeaders,
  [byte[]]$body
) {
  if ($null -eq $body) { $body = [byte[]]@() }
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add("HTTP/1.1 $code $reason")
  foreach ($k in $extraHeaders.Keys) {
    $line = $k + ": " + [string]$extraHeaders[$k]
    [void]$lines.Add($line)
  }
  [void]$lines.Add("Content-Length: $($body.Length)")
  [void]$lines.Add("Connection: close")
  # HTTP exige CRLFCRLF entre o ultimo cabecalho e o corpo; -join sozinho nao garante linha em branco final.
  $headerText = (($lines -join "`r`n") + "`r`n`r`n")
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($body.Length -gt 0) {
    $stream.Write($body, 0, $body.Length)
  }
  $stream.Flush()
}

function Handle-Client([System.Net.Sockets.TcpClient]$client) {
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 60000
    $req = Read-HttpRequestHeaders $stream
    if ($null -eq $req) {
      Send-Response $stream 400 "Bad Request" @{ "Content-Type" = "text/plain; charset=utf-8" } (
        [System.Text.Encoding]::UTF8.GetBytes("Invalid or empty HTTP request.")
      )
      return
    }

    $method = $req.Method
    $tgt = Split-RequestTarget $req.RawPath
    $path = $tgt.Path
    $query = $tgt.Query

    if ($method -eq "OPTIONS") {
      Send-Response $stream 204 "No Content" @{
        "Access-Control-Allow-Origin" = "*"
        "Access-Control-Allow-Methods" = "GET, OPTIONS"
        "Access-Control-Allow-Headers" = "Content-Type"
      } ([byte[]]@())
      return
    }

    if ($method -ne "GET") {
      Send-Response $stream 405 "Method Not Allowed" @{} ([System.Text.Encoding]::UTF8.GetBytes("Method not allowed."))
      return
    }

    $pathNorm = $path.ToLowerInvariant()
    if ($pathNorm -eq "/health.txt") {
      $hb = [System.Text.Encoding]::UTF8.GetBytes("camara-face-identifica server OK`n")
      Send-Response $stream 200 "OK" @{ "Content-Type" = "text/plain; charset=utf-8"; "Cache-Control" = "no-store" } $hb
      return
    }

    if ($pathNorm -eq "/health") {
      $html = "<!DOCTYPE html><html lang=pt-BR><meta charset=utf-8><title>OK</title><body style=margin:40px;font:22px system-ui;background:#0c1222;color:#e8ecf4><h1 style=color:#34d399>Servidor OK</h1><p>camara-face-identifica a correr.</p><p><a href=/ style=color:#38bdf8>Abrir aplicacao</a></p></body></html>"
      $hb = [System.Text.Encoding]::UTF8.GetBytes($html)
      Send-Response $stream 200 "OK" @{ "Content-Type" = "text/html; charset=utf-8"; "Cache-Control" = "no-store" } $hb
      return
    }

    if ($pathNorm -eq "/__debug/info.txt") {
      $idx = Join-Path $PublicRoot "index.html"
      $ajs = Join-Path $PublicRoot "app.js"
      $info = "scriptDir=$ScriptDir`npublicRoot=$PublicRoot`nindexHtml=" + (Test-Path -LiteralPath $idx) + "`nappJs=" + (Test-Path -LiteralPath $ajs) + "`n"
      $infoB = [System.Text.Encoding]::UTF8.GetBytes($info)
      Send-Response $stream 200 "OK" @{ "Content-Type" = "text/plain; charset=utf-8"; "Cache-Control" = "no-store" } $infoB
      return
    }

    if ($pathNorm.StartsWith("/dados-abertos/")) {
      $sub = $pathNorm.Substring("/dados-abertos".Length)
      if ($sub -notmatch '^/v2/[a-z0-9/_-]+$') {
        Send-Response $stream 400 "Bad Request" @{ "Content-Type" = "text/plain; charset=utf-8" } (
          [System.Text.Encoding]::UTF8.GetBytes("Caminho da API invalido.")
        )
        return
      }
      $target = "https://dadosabertos.camara.leg.br/api" + $sub
      if (-not [string]::IsNullOrEmpty($query)) {
        $target = $target + "?" + $query
      }
      try {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("User-Agent", "CamaraFaceIdentifica/1.0 (PowerShell)")
        $wc.Headers.Add("Accept", "application/json")
        $json = $wc.DownloadString($target)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        Send-Response $stream 200 "OK" @{
          "Content-Type" = "application/json; charset=utf-8"
          "Access-Control-Allow-Origin" = "*"
          "Cache-Control" = "public, max-age=120"
        } $bytes
      }
      catch {
        Send-Response $stream 502 "Bad Gateway" @{ "Content-Type" = "text/plain; charset=utf-8" } (
          [System.Text.Encoding]::UTF8.GetBytes("Falha ao consultar API dados abertos.")
        )
      }
      return
    }

    if ($path -eq "/proxy-image") {
      $imageUrl = Get-QueryUrlParam $query
      $baseName = if ($imageUrl) { [System.IO.Path]::GetFileName($imageUrl) } else { "" }
      $validName = $baseName -match "^\d+\.jpg$"
      if (-not $imageUrl -or -not $imageUrl.StartsWith($AllowedPrefix) -or -not $validName) {
        Send-Response $stream 400 "Bad Request" @{ "Content-Type" = "text/plain; charset=utf-8" } (
          [System.Text.Encoding]::UTF8.GetBytes("Invalid image URL.")
        )
        return
      }
      try {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("User-Agent", "CamaraFaceIdentifica/1.0 (PowerShell)")
        $bytes = $wc.DownloadData($imageUrl)
        Send-Response $stream 200 "OK" @{
          "Content-Type" = "image/jpeg"
          "Access-Control-Allow-Origin" = "*"
          "Cache-Control" = "public, max-age=86400"
        } $bytes
      }
      catch {
        Send-Response $stream 502 "Bad Gateway" @{ "Content-Type" = "text/plain; charset=utf-8" } (
          [System.Text.Encoding]::UTF8.GetBytes("Failed to fetch image.")
        )
      }
      return
    }

    $decodedPath = [System.Uri]::UnescapeDataString($path)
    if ($decodedPath -eq "/") { $decodedPath = "/index.html" }

    $rel = $decodedPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    if ($rel.IndexOf("..", [StringComparison]::Ordinal) -ge 0) {
      Send-Response $stream 400 "Bad Request" @{ "Content-Type" = "text/plain; charset=utf-8" } (
        [System.Text.Encoding]::UTF8.GetBytes("Bad path.")
      )
      return
    }
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $PublicRoot $rel))
    $pubFull = [System.IO.Path]::GetFullPath($PublicRoot)
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $pubPrefix = $pubFull.TrimEnd($sep) + $sep
    $underPublic = $filePath.StartsWith($pubPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $filePath.Equals($pubFull, [StringComparison]::OrdinalIgnoreCase)
    if (-not $underPublic) {
      Send-Response $stream 403 "Forbidden" @{ "Content-Type" = "text/plain; charset=utf-8" } (
        [System.Text.Encoding]::UTF8.GetBytes("Forbidden: path outside public folder.")
      )
      return
    }
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf -ErrorAction SilentlyContinue)) {
      Send-Response $stream 404 "Not Found" @{ "Content-Type" = "text/plain; charset=utf-8" } (
        [System.Text.Encoding]::UTF8.GetBytes("Not found.")
      )
      return
    }

    $ext = [System.IO.Path]::GetExtension($filePath)
    $ct = Get-ContentType $ext
    $body = [System.IO.File]::ReadAllBytes($filePath)
    $headers = @{ "Content-Type" = $ct }
    if ($ext.ToLowerInvariant() -match "^\.(html?|js|css)$") {
      $headers["Cache-Control"] = "no-store, must-revalidate"
    }
    Send-Response $stream 200 "OK" $headers $body
  }
  catch {
    try {
      $s = $client.GetStream()
      Send-Response $s 500 "Internal Server Error" @{ "Content-Type" = "text/plain; charset=utf-8" } (
        [System.Text.Encoding]::UTF8.GetBytes("Internal error.")
      )
    }
    catch { }
  }
  finally {
    $client.Close()
  }
}

if (-not (Test-Path -LiteralPath $PublicRoot -PathType Container)) {
  Write-Error "Folder not found: $PublicRoot"
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $PublicRoot "index.html"))) {
  Write-Error "Missing index.html in: $PublicRoot"
  exit 1
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
try {
  $listener.Start()
}
catch {
  Write-Host "Could not bind port $Port. Another app may be using it." -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "Camara Face (PowerShell) $url" -ForegroundColor Cyan
Write-Host "Serving files from: $PublicRoot" -ForegroundColor DarkGray
Write-Host "Debug: ${url}__debug/info.txt" -ForegroundColor DarkGray
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

while ($true) {
  $client = $listener.AcceptTcpClient()
  Handle-Client $client
}
