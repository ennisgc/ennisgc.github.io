#!/usr/bin/env python3
"""Check the site's song data for mistakes before you push.

    python3 tools/check.py            # errors fail (exit 1), warnings don't
    python3 tools/check.py --strict   # warnings fail too
    python3 tools/check.py --deep     # also decode every audio file (slow, ~1-2 min) to find damaged streams

Errors (things that break a page):
  - songs.json missing/invalid, a song without a folder (or a folder not in songs.json)
  - bad genre, performance entry that isn't a song, unknown performanceOrder
  - song.json missing/invalid, a listed audio file that doesn't exist, missing lyrics.txt
  - a song folder without its index.html, or an index.html that differs from the template
  - a placeholder or malformed YouTube ID
  - audio over 128 kbps (fix with: python3 tools/compress-audio.py)
  - an old redirect page (e.g. jingle-bells.html) pointing at a missing folder

Warnings (worth a look):
  - lyrics missing or just a placeholder, no video, no audio at all
  - audio in a format that may not play everywhere (.wav, .mp4, .flac, ...)
  - waveform data (peaks.json) missing or out of date (python3 tools/make-peaks.py)
  - audio files in a folder that no song.json uses, or unsafe file names (spaces etc.)
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "songs"
OK_EXT = {".mp3", ".m4a"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".mp4", ".aac", ".flac", ".ogg", ".aiff", ".aif", ".wma", ".opus"}
errors, warnings = [], []
HAVE_FFMPEG = audio.have_ffmpeg()
DEEP = False


def err(where, msg):
    errors.append(f"{where}: {msg}")


def warn(where, msg):
    warnings.append(f"{where}: {msg}")


def load(path, where):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        err(where, f"{path.name} not found")
    except json.JSONDecodeError as e:
        err(where, f"{path.name} is not valid JSON ({e})")
    return None


def main():
    strict = "--strict" in sys.argv
    global DEEP
    DEEP = "--deep" in sys.argv
    manifest = load(ROOT / "songs.json", "songs.json")
    if manifest is None:
        return finish(strict)

    if not HAVE_FFMPEG:
        warn("tools", "ffprobe not found, so audio bitrates were not checked")
    template_index = (SONGS / "_template" / "index.html")
    template = template_index.read_text() if template_index.exists() else None
    if template is None:
        err("songs/_template", "index.html not found")

    order = manifest.get("performanceOrder", "alphabetical")
    if order not in ("alphabetical", "custom"):
        err("songs.json", f'performanceOrder is "{order}" (use "alphabetical" or "custom")')

    slugs = []
    for s in manifest.get("songs", []):
        slug = s.get("slug", "?")
        slugs.append(slug)
        if not s.get("title"):
            err(f"songs.json [{slug}]", "missing title")
        if s.get("genre") not in ("X", "G", "Co"):
            err(f"songs.json [{slug}]", f'genre is "{s.get("genre")}" (use X, G or Co)')
        if not (SONGS / slug).is_dir():
            err(f"songs.json [{slug}]", f"no folder songs/{slug}/")
    for dup in {s for s in slugs if slugs.count(s) > 1}:
        err("songs.json", f"'{dup}' is listed more than once")
    for slug in manifest.get("performance", []):
        if slug not in slugs:
            err("songs.json performance", f"'{slug}' is not in the songs list")

    for folder in sorted(p for p in SONGS.iterdir() if p.is_dir() and not p.name.startswith("_")):
        if folder.name not in slugs:
            err(f"songs/{folder.name}", "folder is not listed in songs.json")

    for slug in slugs:
        folder = SONGS / slug
        if folder.is_dir():
            check_song(folder, slug, template)

    # old-style redirect pages at the site root
    for stub in sorted(ROOT.glob("*.html")):
        if stub.name == "index.html":
            continue
        m = re.search(r"url=songs/([^/\"]+)/", stub.read_text())
        if m and not (SONGS / m.group(1)).is_dir():
            err(stub.name, f"redirects to songs/{m.group(1)}/ which doesn't exist")

    return finish(strict, len(slugs))


def check_song(folder, slug, template):
    where = f"songs/{slug}"
    idx = folder / "index.html"
    if not idx.exists():
        err(where, "index.html missing (copy it from songs/_template/)")
    elif template is not None and idx.read_text() != template:
        err(where, "index.html differs from songs/_template/index.html")

    song = load(folder / "song.json", where)
    if song is None:
        return
    if not song.get("title"):
        err(where, "song.json has no title")

    referenced = set()
    tracks = 0
    for sec in song.get("sections", []):
        for t in sec.get("tracks", []):
            tracks += 1
            name = t.get("file", "")
            referenced.add(name)
            if not t.get("label"):
                warn(where, f"track {name} has no label")
            if not (folder / name).is_file():
                err(where, f"audio file '{name}' is listed but doesn't exist")
            elif Path(name).suffix.lower() not in OK_EXT:
                warn(where, f"'{name}' may not play in every browser (use .mp3 or .m4a)")
            elif DEEP and HAVE_FFMPEG and not audio.decodes_clean(folder / name):
                err(where, f"'{name}' has a damaged audio stream (Firefox won't play it); "
                           f"run python3 tools/compress-audio.py")
            elif HAVE_FFMPEG and audio.too_big(folder / name):
                err(where, f"'{name}' is {audio.bitrate(folder / name) // 1000} kbps "
                           f"(limit 128); run python3 tools/compress-audio.py")
    if tracks == 0:
        warn(where, "no audio listed")

    for v in song.get("videos", []):
        vid = v.get("id", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
            err(where, f"video id '{vid}' is not a valid YouTube id")
    if not song.get("videos"):
        warn(where, "no video")

    ly = folder / song.get("lyrics", "lyrics.txt")
    if not ly.is_file():
        err(where, f"lyrics file '{ly.name}' doesn't exist")
    elif len(ly.read_text().strip()) < 40:
        warn(where, "lyrics missing or just a placeholder")

    if HAVE_FFMPEG and tracks:
        pf = folder / "peaks.json"
        try:
            peaks = json.loads(pf.read_text()) if pf.exists() else {}
        except json.JSONDecodeError:
            peaks = {}
            err(where, "peaks.json is not valid JSON; run python3 tools/make-peaks.py --all")
        for name in sorted(referenced):
            f = folder / name
            if f.is_file() and (name not in peaks or peaks[name].get("size") != f.stat().st_size or ("keys" not in peaks[name] and audio.have_numpy())):
                warn(where, f"waveform data for '{name}' missing or out of date; run python3 tools/make-peaks.py")

    for f in sorted(folder.iterdir()):
        if f.suffix.lower() in AUDIO_EXT:
            if f.name not in referenced:
                warn(where, f"'{f.name}' is in the folder but not listed in song.json")
            if not re.fullmatch(r"[A-Za-z0-9._-]+", f.name):
                warn(where, f"'{f.name}' has spaces or special characters in its name")


def finish(strict, count=0):
    for e in errors:
        print("ERROR  ", e)
    for w in warnings:
        print("warning", w)
    print(f"\n{count} songs checked: {len(errors)} error(s), {len(warnings)} warning(s).")
    return 1 if errors or (strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
