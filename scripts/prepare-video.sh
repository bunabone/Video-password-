#!/usr/bin/env bash
# Converts a video file into encrypted HLS (AES-128) ready for upload.
# Usage:  ./scripts/prepare-video.sh "/path/to/movie.mp4" [name]
# Output: out/<name>/index.m3u8, out/<name>/enc.key, out/<name>/seg_00000.ts ...
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <video-file> [name]"; exit 1
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (mac: brew install ffmpeg)"; exit 1; }

IN="$1"
NAME="${2:-$(basename "${IN%.*}")}"
NAME="$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+|-+$//g' | cut -c1-40)"
[ -n "$NAME" ] || NAME="video"
OUT="out/$NAME"

rm -rf "$OUT"; mkdir -p "$OUT"
head -c 16 /dev/urandom > "$OUT/enc.key"
printf 'key\n%s\n' "$OUT/enc.key" > "$OUT/keyinfo.txt"

ffmpeg -hide_banner -y -i "$IN" \
  -map 0:v:0 -map "0:a:0?" \
  -c:v libx264 -preset medium -crf 21 -maxrate 6M -bufsize 12M -pix_fmt yuv420p \
  -vf "scale=-2:'min(1080,ih)'" \
  -force_key_frames "expr:gte(t,n_forced*6)" \
  -c:a aac -b:a 160k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_key_info_file "$OUT/keyinfo.txt" \
  -hls_segment_filename "$OUT/seg_%05d.ts" \
  "$OUT/index.m3u8"

rm -f "$OUT/keyinfo.txt"
echo
echo "Done: $OUT  ($(ls "$OUT" | wc -l) files, $(du -sh "$OUT" | cut -f1))"
echo "Now open <your-site>/admin.html -> 'סרטונים והעלאה' and upload this folder."
