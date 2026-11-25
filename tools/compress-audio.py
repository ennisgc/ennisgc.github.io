#!/usr/bin/env python3
"""Bring all audio under songs/ down to 128 kbps (never touches files already at or below it).

    python3 tools/compress-audio.py --dry-run   # list what would change
    python3 tools/compress-audio.py             # do it
    python3 tools/compress-audio.py --check     # report only; exit 1 if anything is over the limit

  * .mp3 / .m4a over the limit, or with a damaged audio stream (some recorder AAC that Firefox
    refuses to play), are re-encoded in the same format
  * .wav / .flac / audio-only .mp4 etc. become .m4a (and song.json is updated to match)
The original files stay recoverable from git history. Re-run any time; it's idempotent.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "songs"
MB = 1024 * 1024


def main():
    dry = "--dry-run" in sys.argv
    check = "--check" in sys.argv
    if not audio.have_ffmpeg():
        sys.exit("ffmpeg/ffprobe not found (sudo apt install ffmpeg).")

    changes, before_total, after_total, skipped = [], 0, 0, 0
    for folder in sorted(p for p in SONGS.iterdir() if p.is_dir() and not p.name.startswith("_")):
        renames = {}
        for f in sorted(folder.iterdir()):
            ext = f.suffix.lower()
            if ext not in audio.AUDIO_EXT:
                continue
            br = audio.bitrate(f)
            big = br > audio.LIMIT * audio.TOLERANCE
            bad = ext in audio.OK_EXT and not audio.decodes_clean(f)  # damaged stream: Firefox won't play it
            if ext in audio.OK_EXT and not big and not bad:
                skipped += 1
                continue
            target = f if ext in audio.OK_EXT else f.with_suffix(".m4a")
            how = ("re-encode (damaged stream)" if bad and not big else "compress") if ext in audio.OK_EXT else "convert"
            size = f.stat().st_size
            changes.append((f, br, how))
            if check or dry:
                print(f"  {f.relative_to(ROOT)}  {br // 1000} kbps  -> {how}")
                continue
            try:
                if ext not in audio.OK_EXT and audio.codec(f) == "aac" and not big and audio.decodes_clean(f):
                    audio.remux(f, target)
                else:
                    audio.encode(f, target)
            except Exception as e:  # keep going, report at the end
                print(f"  FAILED {f.relative_to(ROOT)}: {e}")
                continue
            new = target.stat().st_size
            if target != f:
                f.unlink()
                renames[f.name] = target.name
            before_total += size
            after_total += new
            print(f"  {f.relative_to(ROOT)}  {br // 1000} kbps, {size / MB:.1f} -> {new / MB:.1f} MB")
        if not dry and not check:
            audio.update_peaks(folder)  # keeps waveforms in step with any re-encoded file
        if renames and not dry:
            sj = folder / "song.json"
            data = json.loads(sj.read_text())
            for sec in data.get("sections", []):
                for t in sec.get("tracks", []):
                    t["file"] = renames.get(t["file"], t["file"])
            sj.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print(f"\n{len(changes)} file(s) {'need' if (check or dry) else 'processed'}; "
          f"{skipped} already within 128 kbps.")
    if not (check or dry) and changes:
        print(f"Size: {before_total / MB:.1f} MB -> {after_total / MB:.1f} MB "
              f"(saved {(before_total - after_total) / MB:.1f} MB)")
    return 1 if (check and changes) else 0


if __name__ == "__main__":
    sys.exit(main())
