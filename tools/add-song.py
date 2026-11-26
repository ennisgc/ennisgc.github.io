#!/usr/bin/env python3
"""Add a new song to the site.

    tools/add-song.py "Song Title" --genre X --audio backing.mp3 alto.m4a men.wav \\
        --lyrics lyrics.txt --performance

What it does:
  * creates songs/<slug>/ from songs/_template/
  * copies in (and, if needed, converts or compresses to 128 kbps) your audio files, working out from each
    file name whether it is a backing track, a line tape or a practice recording
  * writes song.json and lyrics.txt
  * registers the song in songs.json (and the performance list with --performance)

Genres: X = Christmas, G = Gospel, Co = Contemporary.
Audio file names are matched on keywords (case-insensitive):
  original / og                         -> Original Audio (the full song as released; own "Full Song" section)
  backing / bt / karaoke / instrumental -> Backing Track
  soprano / alto / men / tenor / bass   -> Line Tape (e.g. "men-soprano" -> "Men & Soprano")
  anything else                         -> Practice Recording
Run with --dry-run to see what would happen without changing anything.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "songs"
MANIFEST = ROOT / "songs.json"
GENRES = {"X": "Christmas", "G": "Gospel", "Co": "Contemporary"}
AUDIO_EXT = audio.AUDIO_EXT
PARTS = {"soprano": "Soprano", "alto": "Alto", "men": "Men", "tenor": "Tenor", "bass": "Bass"}
BACKING_WORDS = {"backing", "bt", "karaoke", "instrumental"}


def slugify(text):
    text = re.sub(r"['’`]", "", text.lower())
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def classify(path):
    """Return (kind, label, base) for an audio file name."""
    stem = re.sub(r"[^a-z0-9]+", " ", path.stem.lower()).split()
    parts = [PARTS[w] for w in stem if w in PARTS]
    if parts:
        label = " & ".join(parts)
        return "line", label, "line-tape-" + slugify(label)
    if {"original", "og"} & set(stem):
        return "orig", "Original Audio", "original-audio"
    if BACKING_WORDS & set(stem):
        return "rec", "Backing Track", "backing-track"
    label = "Practice Recording"
    if "men" in stem:
        label += " (Men Focused)"
    return "rec", label, slugify(label)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("title")
    ap.add_argument("--genre", "-g", required=True, choices=GENRES, help="X, G or Co")
    ap.add_argument("--audio", "-a", nargs="*", default=[], type=Path)
    ap.add_argument("--lyrics", "-l", type=Path, help="text file with the lyrics")
    ap.add_argument("--slug", help="override the folder name")
    ap.add_argument("--performance", "-p", action="store_true", help="also add to the performance list")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    slug = args.slug or slugify(args.title)
    folder = SONGS / slug
    manifest = json.loads(MANIFEST.read_text())
    if folder.exists() or any(s["slug"] == slug for s in manifest["songs"]):
        sys.exit(f"'{slug}' already exists. Pick another title or use --slug.")
    for f in args.audio + ([args.lyrics] if args.lyrics else []):
        if not f.is_file():
            sys.exit(f"File not found: {f}")
    for f in args.audio:
        if f.suffix.lower() not in AUDIO_EXT:
            sys.exit(f"'{f.name}' doesn't look like an audio file (pass lyrics with --lyrics).")

    print(f"{'[dry run] ' if args.dry_run else ''}Adding '{args.title}' ({GENRES[args.genre]}) as songs/{slug}/")
    if not args.dry_run:
        folder.mkdir(parents=True)
        shutil.copy(SONGS / "_template" / "index.html", folder / "index.html")

    rec, line, orig, used = [], [], [], set()
    if args.audio:
        print("  Audio:")
    for src in sorted(args.audio, key=lambda p: p.name.lower()):
        kind, label, base = classify(src)
        final, n = base, 2
        while final in used:  # two files with the same role
            final, n = f"{base}-{n}", n + 1
        used.add(final)
        if final != base:
            label += f" {n - 1}"
        try:
            name, how = audio.import_file(src, final, folder, args.dry_run)
        except Exception as e:
            sys.exit(f"Could not import {src.name}: {e}")
        print(f"    {src.name}  ->  {name}  ({how})")
        {"line": line, "orig": orig}.get(kind, rec).append({"label": label, "file": name})
    rec.sort(key=lambda t: t["label"] != "Backing Track")  # backing track first

    sections = []
    if rec:
        sections.append({"heading": "Backing Tracks / Recordings", "tracks": rec})
    if line:
        sections.append({"heading": "Line Tapes", "tracks": line})
    if orig:
        sections.append({"heading": "Full Song", "tracks": orig})
    song = {
        "title": args.title,
        "sections": sections,
        "lyrics": "lyrics.txt",
    }
    lyrics = args.lyrics.read_text() if args.lyrics else "Lyrics to be added\n"

    manifest["songs"].append({"slug": slug, "title": args.title, "genre": args.genre})
    if args.performance:
        manifest.setdefault("performance", []).append(slug)

    if not args.dry_run:
        if args.audio and audio.have_ffmpeg():
            audio.update_peaks(folder)
        (folder / "song.json").write_text(json.dumps(song, indent=2, ensure_ascii=False) + "\n")
        (folder / "lyrics.txt").write_text(lyrics if lyrics.endswith("\n") else lyrics + "\n")
        MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    todo = []
    if not args.lyrics:
        todo.append(f"paste the lyrics into songs/{slug}/lyrics.txt")
    if not orig:
        todo.append(f'add the original audio (name the file "original", e.g. original.m4a) so it lands under "Full Song" in songs/{slug}/song.json')
    if not args.audio:
        todo.append(f"drop audio into songs/{slug}/ and list it in song.json")
    print("\nDone." if not args.dry_run else "\nNothing was changed (dry run).")
    for t in todo:
        print("  TODO:", t)
    print("Next: python3 tools/check.py, preview with python3 -m http.server, then commit and push.")


if __name__ == "__main__":
    main()
