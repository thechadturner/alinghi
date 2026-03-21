@echo off
setlocal enabledelayedexpansion
REM Convert videos to medium quality (med_res) matching server_admin/middleware/media.js
REM Processes all files in INPUTDIR one by one and saves to OUTDIR (same filenames).

set "INPUTDIR=C:\Users\guyt2\OneDrive\Desktop\video\20260301"
set "OUTDIR=C:\Users\guyt2\OneDrive\Desktop\video\20260301\downsampled"

where ffmpeg >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo Error: ffmpeg is not in your PATH. Install ffmpeg or run this from a terminal where ffmpeg is available.
  pause
  exit /b 1
)

if not exist "%INPUTDIR%" (
  echo Error: Input directory not found: %INPUTDIR%
  pause
  exit /b 1
)

if not exist "%OUTDIR%" (
  echo Creating output directory: %OUTDIR%
  mkdir "%OUTDIR%"
)

set "COUNT=0"
for /f "delims=" %%F in ('dir /b /a-d "%INPUTDIR%\*" 2^>nul') do (
  set /a COUNT+=1
  set "INFILE=%INPUTDIR%\%%F"
  set "OUTFILE=%OUTDIR%\%%F"
  echo.
  echo [!COUNT!] Processing: %%F
  ffmpeg -i "!INFILE!" -y -vf "scale=920:-2:flags=lanczos,unsharp=5:5:0.8" -c:v libx264 -pix_fmt yuv420p -crf 26 -preset slow -c:a aac -b:a 48k -movflags faststart "!OUTFILE!"
  if !ERRORLEVEL! equ 0 (
    echo Done. Output: !OUTFILE!
  ) else (
    echo ffmpeg failed for %%F with exit code !ERRORLEVEL!
  )
)

echo.
echo All files processed.
pause
endlocal
</think>
Fixing the edit: adding `setlocal enabledelayedexpansion` at the start and removing the duplicated/partial loop.
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
Read