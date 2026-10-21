param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Method = "GET",
    [string]$Path = "/",
    [string]$BodyPath,
    [string]$Dir
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http | Out-Null
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$base = $Url.TrimEnd("/")
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromMinutes(5)
$client.DefaultRequestHeaders.Add("Authorization", "Bearer $Token")

function Show-Result($label, $res, $body) {
    $colour = if ($res.IsSuccessStatusCode) { "Green" } else { "Red" }
    Write-Host ("{0} -> HTTP {1} {2}" -f $label, [int]$res.StatusCode, $res.ReasonPhrase) -ForegroundColor $colour
    if ($body) { Write-Host $body }
}
function Send-Bytes($endpoint, $bytes, $contentType) {
    $content = [System.Net.Http.ByteArrayContent]::new($bytes)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new($contentType)
    $res = $client.PostAsync($endpoint, $content).GetAwaiter().GetResult()
    $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    Show-Result $endpoint ($res) $body
    return $res
}

try {
    if ($Method -eq "GET") {
        $res = $client.GetAsync($base + $Path).GetAwaiter().GetResult()
        $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        Show-Result ($base + $Path) $res ($body.Substring(0, [Math]::Min(300, $body.Length)))
    }
    elseif ($BodyPath) {
        $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $BodyPath))
        Write-Host ("Sending {0} ({1:N0} bytes) to {2}" -f (Split-Path $BodyPath -Leaf), $bytes.Length, $base)
        Send-Bytes ($base + "/api/admin/restore-db") $bytes "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | Out-Null
    }

    if ($Dir) {
        $pics = Get-ChildItem -LiteralPath $Dir -File |
                Where-Object { $_.Extension -in ".png", ".jpg", ".jpeg", ".webp" }
        Write-Host ("`nUploading {0} picture(s) from {1}" -f $pics.Count, $Dir)
        foreach ($pic in $pics) {
            $picBytes = [System.IO.File]::ReadAllBytes($pic.FullName)
            $endpoint = $base + "/api/admin/restore-photo?name=" + [Uri]::EscapeDataString($pic.Name)
            Send-Bytes $endpoint $picBytes "application/octet-stream" | Out-Null
        }
    }

    if ($Method -ne "GET" -and -not $BodyPath -and -not $Dir) {
        Write-Host "Nothing to send. Use -BodyPath and/or -Dir."
    }
}
finally {
    $client.Dispose()
}
