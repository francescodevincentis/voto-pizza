@echo off
chcp 65001 >nul
title Voto Pizza
REM Avvia Voto Pizza su un portatile Windows. Apre la regia con l'indirizzo di rete
REM (non "localhost"), cosi' i QR stampati puntano al portatile e i telefoni
REM collegati alla stessa Wi-Fi li possono aprire, anche senza Internet.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js non e' installato. Scaricalo da https://nodejs.org ^(versione LTS^),
  echo   installalo e poi fai di nuovo doppio clic su avvia.bat.
  echo.
  pause
  exit /b 1
)

set IP=
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress"`) do set IP=%%a
if "%IP%"=="" set IP=localhost

echo.
echo   Indirizzo del portatile sulla Wi-Fi: %IP%
if "%IP%"=="localhost" echo   ATTENZIONE: il PC non e' collegato a nessuna Wi-Fi. Collegalo e riavvia.
echo   Se Windows chiede di consentire l'accesso a Node.js, scegli "Consenti" (reti private).
echo   Per fermare l'app chiudi questa finestra.
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://%IP%:3000/admin'"
node server.js
pause
