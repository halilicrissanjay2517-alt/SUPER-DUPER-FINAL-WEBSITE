# ---------------------------------------------------------------------------
# push-db.ps1 — copy the live workbook from this PC to the deployed server.
#
# WHY THIS EXISTS
#   database.xlsx is git-ignored on purpose: it holds real students' names,
#   contact details, tuition balances and password hashes, and it must never
#   land in a public repo. So the repo deploys the CODE only. This script moves
#   the DATA over HTTPS afterwards, straight onto the server's persistent disk
#   (DB_DIR), using the staff-only upload endpoint.
#
# USAGE
#   1. Deploy and confirm the site loads.
#   2. In Render/ Railway -> your service -> Environment, set SPA_DB_UPLOAD_TOKEN
#      to a long random string. Redeploy so the server picks it up.
#   3. Run from this folder:
#        .\push-db.ps1 -Url https://your-app.onrender.com -Token <that string>
#   4. Optional flags:
#        -File database.xlsx        workbook to send (default: live one)
#        -Dir  .\photos             also upload profile pictures, if used
#        -WhatIf                    show what would happen, send nothing
#
# SAFETY
#   The server keeps a timestamped copy of whatever it replaces, so a bad push
#   is recoverable from the disk. Run it once more after any local edits that
#   must reach production.
# ---------------------------------------------------------------------------

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$File = (Join-Path $PSScriptRoot "database.xlsx"),
    [string]$Dir
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http | Out-Null

if (-not (Test-Path -LiteralPath $File)) {
    throw "Workbook not found: $File"
}

$endpoint = ($Url.TrimEnd("/")) + "/api/admin/restore-db"
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $File))
Write-Host ("Sending {0} ({1:N0} bytes) to {2}" -f (Split-Path $File -Leaf), $bytes.Length, $endpoint)

if (-not $PSCmdlet.ShouldProcess($endpoint, "Upload workbook")) { return }

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromMinutes(5)
$client.DefaultRequestHeaders.Add("Authorization", "Bearer $Token")

try {
    $content = [System.Net.Http.ByteArrayContent]::new($bytes)
    $content.Headers.ContentType =
        [System.Net.Http.Headers.MediaTypeHeaderValue]::new(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    $res = $client.PostAsync($endpoint, $content).GetAwaiter().GetResult()
    $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if (-not $res.IsSuccessStatusCode) {
        # 401 means the token is wrong; 404 means the endpoint is not deployed
        # yet; 413 means the file exceeded the server's upload limit.
        throw "Upload failed: HTTP $([int]$res.StatusCode) $($res.ReasonPhrase)`n$body"
    }
    Write-Host "Uploaded. Server said:" -ForegroundColor Green
    Write-Host $body

    if ($Dir) {
        if (-not (Test-Path -LiteralPath $Dir)) { throw "Photo folder not found: $Dir" }
        $pics = Get-ChildItem -LiteralPath $Dir -File |
                Where-Object { $_.Extension -in ".png", ".jpg", ".jpeg", ".webp" }
        Write-Host ("`nUploading {0} profile picture(s) from {1}" -f $pics.Count, $Dir)
        foreach ($pic in $pics) {
            $picBytes = [System.IO.File]::ReadAllBytes($pic.FullName)
            $picContent = [System.Net.Http.ByteArrayContent]::new($picBytes)
            $picContent.Headers.ContentType =
                [System.Net.Http.Headers.MediaTypeHeaderValue]::new("application/octet-stream")
            $picEndpoint = ($Url.TrimEnd("/")) + "/api/admin/restore-photo?name=" +
                           [Uri]::EscapeDataString($pic.Name)
            $r = $client.PostAsync($picEndpoint, $picContent).GetAwaiter().GetResult()
            $colour = if ($r.IsSuccessStatusCode) { "Green" } else { "Red" }
            Write-Host ("  {0} -> {1}" -f $pic.Name, [int]$r.StatusCode) -ForegroundColor $colour
        }
    }
}
finally {
    $client.Dispose()
}
