@echo off
setlocal

set "SOURCE=%~dp0tabby-hubterm"
set "TARGET=%APPDATA%\tabby\plugins\node_modules\tabby-hubterm"

if not exist "%SOURCE%\package.json" (
  echo [ERROR] Plugin files are missing.
  pause
  exit /b 1
)

if not exist "%TARGET%" mkdir "%TARGET%"
xcopy "%SOURCE%\*" "%TARGET%\" /E /I /Y >nul
if errorlevel 1 (
  echo [ERROR] Installation failed: %TARGET%
  pause
  exit /b 1
)

echo.
echo HubTerm plugin installed successfully.
echo Token will be registered automatically on first connection.
echo Location: %TARGET%
echo Please restart Tabby completely and open a terminal tab.
echo.
pause
