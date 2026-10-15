@echo off
REM start-chrome.cmd - start Chrome with remote debugging so the collector can
REM attach to your running session (used only to refresh auth.json).
REM Close Chrome first, then run this once. After that keep Chrome running;
REM the scripts work inside your normal Chrome and never reopen/touch the profile.
setlocal
if not defined CHROME_EXE (
  if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
  ) else if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
  ) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  )
)
if not defined CHROME_EXE (
  echo Could not find chrome.exe. Set CHROME_EXE and re-run.
  exit /b 1
)
start "TwitterPlaywrightChrome" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"
