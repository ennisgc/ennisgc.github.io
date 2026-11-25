# Site tools

Run from the repo root. Needs Python 3; `ffmpeg` is used to convert audio.

## Add a song

    python3 tools/add-song.py "Song Title" --genre X \
        --audio backing.mp3 alto.m4a men-soprano.wav \
        --video https://www.youtube.com/watch?v=XXXXXXXXXXX \
        --lyrics lyrics.txt --performance

- `--genre`: `X` Christmas, `G` Gospel, `Co` Contemporary
- Everything except the title and genre is optional; it tells you what is still to do.
- Audio is sorted by file name: `backing`/`bt`/`karaoke` = backing track,
  `soprano`/`alto`/`men`/`tenor`/`bass` = line tape, anything else = practice recording.
  `.mp3` and `.m4a` at or under 128 kbps are copied as they are; anything higher is compressed
  to 128 kbps, and other formats are converted (or repackaged) to `.m4a`.
- `--performance` also adds it to the performance list. `--dry-run` previews.

## Keep audio at 128 kbps or below

    python3 tools/compress-audio.py --dry-run   # list what would change
    python3 tools/compress-audio.py             # do it
    python3 tools/compress-audio.py --check     # report only

Re-encodes anything over 128 kbps (never touches files already under it) and turns `.wav` etc. into
`.m4a`, updating `song.json`. `add-song.py` does this automatically for new audio, and `check.py`
fails if any audio is over the limit (e.g. after you drop a file straight into a song folder).
Originals stay recoverable from git history.

## Check for mistakes

    python3 tools/check.py            # errors fail, warnings don't
    python3 tools/check.py --strict   # warnings fail too

Run it before every push. It also fails if any audio is over 128 kbps. Preview locally with `python3 -m http.server`.
