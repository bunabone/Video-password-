@echo off
rem Converts a video into encrypted HLS (AES-128) ready for upload.
rem Usage: drag the video file onto this .bat, or run:  prepare-video.bat "C:\path\movie.mp4" [name]
rem Output: out\<name>\  (next to this script)
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" (
  echo Drag a video file onto this file, or run: prepare-video.bat "C:\path\movie.mp4" my-movie
  pause & exit /b 1
)
where ffmpeg >nul 2>&1 || (
  echo ffmpeg is not installed. Install it with:  winget install Gyan.FFmpeg   then reopen this window.
  pause & exit /b 1
)

set "IN=%~f1"
set "NAME=%~2"
if "%NAME%"=="" set "NAME=video"
set "OUT=%CD%\out\%NAME%"

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"
powershell -NoProfile -Command "$b=New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [IO.File]::WriteAllBytes('%OUT%\enc.key',$b)"
(echo key& echo %OUT%\enc.key)> "%OUT%\keyinfo.txt"

ffmpeg -hide_banner -y -i "%IN%" ^
  -map 0:v:0 -map "0:a:0?" ^
  -c:v libx264 -preset medium -crf 21 -maxrate 6M -bufsize 12M -pix_fmt yuv420p ^
  -vf "scale=-2:'min(1080,ih)'" ^
  -force_key_frames "expr:gte(t,n_forced*6)" ^
  -c:a aac -b:a 160k -ac 2 ^
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments ^
  -hls_key_info_file "%OUT%\keyinfo.txt" ^
  -hls_segment_filename "%OUT%\seg_%%05d.ts" ^
  "%OUT%\index.m3u8"
if errorlevel 1 ( echo. & echo ffmpeg failed. & pause & exit /b 1 )

del "%OUT%\keyinfo.txt"
echo.
echo Done: %OUT%
echo Now open your-site/admin.html, tab "videos", and upload this folder.
pause
