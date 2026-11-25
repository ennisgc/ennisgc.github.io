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
    if ext == ".mp3":
        name, how = dest_base + ".mp3", "compress to 128 kbps" if big else "copy"
    elif ext == ".m4a":
        name, how = dest_base + ".m4a", "compress to 128 kbps" if big else "copy"
    elif have_ffmpeg() and codec(src) == "aac" and not big:
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
