@echo off
cd /d "%~dp0"
echo Iniciando servidor local (sem precisar de Node.js nem de administrador)...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0servidor.ps1"
if errorlevel 1 (
  echo.
  echo O servidor em PowerShell falhou. Tentando Node.js ^(se estiver instalado^)...
  where node >nul 2>&1
  if errorlevel 1 (
    echo Nao foi possivel iniciar. Abra servidor.ps1 com PowerShell ou instale Node.js.
    pause
    exit /b 1
  )
  node servidor.mjs
)
pause
