"""Shared audio helpers for the site tools (bitrate limit, probing, encoding)."""
import shutil
import subprocess
from pathlib import Path

LIMIT = 128_000            # bits per second
TOLERANCE = 1.05           # a "128 kbps" file measures a little over; don't re-encode it
OK_EXT = {".mp3", ".m4a"}  # formats that play everywhere
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".mp4", ".aac", ".flac", ".ogg", ".aiff", ".aif", ".wma", ".opus"}


def have_ffmpeg():
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _probe(path, entries, stream=True):
    sel = ["-select_streams", "a:0", "-show_entries", f"stream={entries}"] if stream else \
          ["-show_entries", f"format={entries}"]
    out = subprocess.run(["ffprobe", "-v", "error", *sel, "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True)
    return out.stdout.strip()


def codec(path):
    return _probe(path, "codec_name")


def duration(path):
    try:
        return float(_probe(path, "duration", stream=False))
    except ValueError:
        return 0.0


def bitrate(path):
    """Average audio bit rate in bits/second (falls back to size / duration)."""
    for entries, stream in (("bit_rate", True), ("bit_rate", False)):
        try:
            br = int(_probe(path, entries, stream))
            if br > 0:
                return br
        except ValueError:
            pass
    d = duration(path)
    return int(Path(path).stat().st_size * 8 / d) if d else 0


def decodes_clean(path):
    """True if ffmpeg can decode the whole file without complaint. Some phone/recorder AAC files
    decode with errors; browsers such as Firefox refuse to play those."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"],
                         capture_output=True, text=True)
    return out.returncode == 0 and not out.stderr.strip()


def too_big(path):
    return bitrate(path) > LIMIT * TOLERANCE


def encode(src, dest):
    """Encode src to dest (.mp3 or .m4a) at the bitrate limit. Raises if the result looks wrong."""
    dest = Path(dest)
    tmp = dest.with_name(dest.stem + ".tmp" + dest.suffix)
    lib = ["-c:a", "libmp3lame"] if dest.suffix == ".mp3" else ["-c:a", "aac"]
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vn", *lib, "-b:a", f"{LIMIT // 1000}k"]
    if dest.suffix == ".m4a":
        cmd += ["-movflags", "+faststart"]
    subprocess.run([*cmd, str(tmp)], check=True)
    if abs(duration(tmp) - duration(src)) > 1.0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"encoded length of {Path(src).name} doesn't match the original")
    tmp.replace(dest)


def remux(src, dest):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vn", "-c:a", "copy",
                    "-movflags", "+faststart", str(dest)], check=True)


def import_file(src, dest_base, dest_dir, dry=False):
    """Bring src into dest_dir as <dest_base>.<mp3|m4a>, at most 128 kbps.
    Returns (final file name, description of what was done)."""
    src, dest_dir = Path(src), Path(dest_dir)
    ext = src.suffix.lower()
    big = have_ffmpeg() and too_big(src)
    damaged = have_ffmpeg() and not decodes_clean(src)  # would not play in every browser as-is
    redo = big or damaged
    why = "compress to 128 kbps" if big else "re-encode (damaged audio stream)"
    if ext == ".mp3":
        name, how = dest_base + ".mp3", why if redo else "copy"
    elif ext == ".m4a":
        name, how = dest_base + ".m4a", why if redo else "copy"
    elif have_ffmpeg() and codec(src) == "aac" and not redo:
        name, how = dest_base + ".m4a", "repackage as .m4a"
    else:
        name, how = dest_base + ".m4a", "convert to AAC 128 kbps"
    if dry:
        return name, how
    dest = dest_dir / name
    if how == "copy":
        shutil.copy(src, dest)
    elif how.startswith("repackage"):
        remux(src, dest)
    else:
        if not have_ffmpeg():
            raise RuntimeError("ffmpeg is needed to convert " + src.name)
        encode(src, dest)
    return name, how


# ---- waveform peaks (used by the in-page player so waveforms appear without downloading audio) ----
PEAK_POINTS = 500


def compute_peaks(path, n=PEAK_POINTS):
    """Return {'size', 'duration', 'peaks'} where peaks are n values in 0..1 (loudest sample per slice)."""
    from array import array
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "4000",
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    samples = array("h")
    samples.frombytes(raw[: len(raw) // 2 * 2])
    total = len(samples)
    step = max(1, total // n)
    peaks = []
    for i in range(n):
        sl = samples[i * step:(i + 1) * step]
        peaks.append(max(max(sl), -min(sl)) if sl else 0)
    top = max(peaks) or 1
    return {"size": Path(path).stat().st_size, "duration": round(duration(path), 3),
            "peaks": [round(p / top, 2) for p in peaks]}


def peaks_file(folder):
    return Path(folder) / "peaks.json"


def update_peaks(folder, only_missing=True):
    """(Re)build folder/peaks.json for every mp3/m4a in the folder. Returns number of files computed."""
    import json
    folder = Path(folder)
    pf = peaks_file(folder)
    data = json.loads(pf.read_text()) if pf.exists() else {}
    present = sorted(f.name for f in folder.iterdir() if f.suffix.lower() in OK_EXT)
    changed = 0
    for name in present:
        entry = data.get(name)
        if only_missing and entry and entry.get("size") == (folder / name).stat().st_size:
            continue
        data[name] = compute_peaks(folder / name)
        changed += 1
    for name in list(data):
        if name not in present:  # file was removed or renamed
            del data[name]
            changed += 1
    if changed or not pf.exists():
        if data:
            pf.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        elif pf.exists():
            pf.unlink()
    return changed
