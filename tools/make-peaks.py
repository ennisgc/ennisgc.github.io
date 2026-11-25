#!/usr/bin/env python3
"""Build the waveform data (songs/<song>/peaks.json) that the in-page player draws.

    python3 tools/make-peaks.py            # add/refresh any missing or out-of-date entries
    python3 tools/make-peaks.py --all      # rebuild everything
    python3 tools/make-peaks.py --check    # report only; exit 1 if anything is missing or stale

add-song.py and compress-audio.py run this for you; check.py reports stale data.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "songs"


def stale(folder):
    """Names of audio files in folder with no (or out-of-date) peaks entry."""
    pf = audio.peaks_file(folder)
    data = json.loads(pf.read_text()) if pf.exists() else {}
    bad = []
    for f in sorted(folder.iterdir()):
        if f.suffix.lower() in audio.OK_EXT:
            e = data.get(f.name)
            if not e or e.get("size") != f.stat().st_size:
                bad.append(f.name)
    return bad


def main():
    check, everything = "--check" in sys.argv, "--all" in sys.argv
    if not audio.have_ffmpeg():
        sys.exit("ffmpeg/ffprobe not found (sudo apt install ffmpeg).")
    total = 0
    for folder in sorted(p for p in SONGS.iterdir() if p.is_dir() and not p.name.startswith("_")):
        if check:
            for name in stale(folder):
                print(f"  {folder.name}/{name}: waveform data missing or out of date")
                total += 1
        else:
            n = audio.update_peaks(folder, only_missing=not everything)
            if n:
                print(f"  {folder.name}: {n} file(s) updated")
            total += n
    print(f"\n{total} file(s) {'need waveform data' if check else 'updated'}.")
    return 1 if (check and total) else 0


if __name__ == "__main__":
    sys.exit(main())
