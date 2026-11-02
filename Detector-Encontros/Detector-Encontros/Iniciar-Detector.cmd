@echo off
setlocal
title Detector de Encontros
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale Node.js 22 ou superior com npm e tente novamente.
  if "%~1"=="" pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs" %*
set "DETECTOR_EXIT_CODE=%ERRORLEVEL%"
if not "%DETECTOR_EXIT_CODE%"=="0" if "%~1"=="" pause
exit /b %DETECTOR_EXIT_CODE%
