param(
    [string]$ApiBase = 'https://valaxscrub.rf.gd/api'
)

Write-Host 'Matcha Accounting - Deployment Readiness Check'

$files = @(
    'config.php','login.php','logout.php','middleware.php','health.php','api-manifest.json',
    'core\\response.php','core\\jwt.php','core\\database.php','cors.php'
)

$missing = $files | ForEach-Object { Join-Path $PWD $_ } | Where-Object { -not (Test-Path $_) }
if ($missing.Count -gt 0) {
    Write-Host "Missing files:`n$($missing -join "`n")"
} else {
    Write-Host 'All core files present.'
}

try {
    $manifest = Get-Content -Raw -Path (Join-Path $PWD 'api-manifest.json') | ConvertFrom-Json
    Write-Host "Manifest loaded. Endpoints: $($manifest.api_endpoints.base)"
} catch {
    Write-Host 'Manifest parse failed:' $_.Exception.Message
}

$targets = @(
    '/health.php',
    '/login.php',
    '/logout.php',
    '/customer/list.php'
)

if ($env:Path) {
    Write-Host 'This check is offline (no outbound network probe from workspace).' 
}

Write-Host 'Deployment checklist complete.'
