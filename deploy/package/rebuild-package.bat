@echo off
setlocal

echo ================================
echo Matcha Accounting Deploy Package
 echo ================================

echo [1/5] API files -> package/api
robocopy "..\api" "package\api" /E /R:1 /W:1 /NP

echo [2/5] SQL schema -> package\schema.sql
copy ..\sql\schema.sql package\schema.sql
copy ..\docs\deployment.md package\deployment.md

echo [3/5] Create deploy notes
copy ..\deploy\deploy-notes.txt package\deploy-notes.txt >nul 2>nul
copy ..\deploy\deploy-check.ps1 package\deploy-check.ps1 >nul 2>nul

echo [4/5] Ready

echo [5/5] Done

pause
