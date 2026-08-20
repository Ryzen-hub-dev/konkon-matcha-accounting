param(
    [string]$Server = 'valaxscrub.rf.gd'
)

$base = "https://$Server/api"

Write-Host "Check these endpoints after upload:" -ForegroundColor Cyan
Write-Host "1) $base/health.php"
Write-Host "2) POST $base/login.php"
Write-Host "3) POST $base/logout.php"
Write-Host "4) GET  $base/customer/list.php (needs token)"
