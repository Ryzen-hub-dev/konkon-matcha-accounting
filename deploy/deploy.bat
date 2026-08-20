@echo off
setlocal
set ROOT=%~dp0
set API_ROOT=%ROOT%upload

if not exist "%API_ROOT%\config.php" (
  echo ERROR: Missing API files. Ensure deploy\upload contains API package.
  exit /b 1
)

echo ===========================
echo Matcha Accounting Deploy Helper
echo ===========================

echo 1) Upload files under deploy\upload to your InfinityFree public_html/api
echo    - via File Manager in InfinityFree
echo    - or FTP (enable passive mode)

echo.
echo 2) Run SQL script from sql\schema.sql in phpMyAdmin/Database panel
echo 3) Edit deploy\upload\config.php (production DB & secrets)
echo 4) Verify
echo    - curl https://valaxscrub.rf.gd/api/health.php
echo    - curl -X POST https://valaxscrub.rf.gd/api/login.php -H "Content-Type: application/json" -d '{"username":"admin","password":"password"}'
echo.
echo Deploy package prepared.

exit /b 0
