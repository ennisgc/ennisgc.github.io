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
    entry = {"size": Path(path).stat().st_size, "duration": round(duration(path), 3),
             "peaks": [round(p / top, 2) for p in peaks]}
    if have_numpy():
        entry["keys"] = compute_keys(path)
    return entry


# ---- key estimate (shown under the waveform) ----
KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]   # Krumhansl-Kessler profiles
_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
KEY_WINDOW, KEY_HOP, KEY_MIN_SEGMENT, KEY_SWITCH_COST = 20.0, 5.0, 25.0, 0.3


def have_numpy():
    try:
        import numpy  # noqa: F401
        return True
    except ImportError:
        return False


def compute_keys(path):
    """Estimate the key over time. Returns [{'start': seconds, 'key': 'F major', 'rel': 'D minor'}, ...].
    Chroma (pitch-class energy) in 20 s windows, matched to major/minor key profiles, then smoothed so
    a change is only reported if it lasts. Relative major/minor are indistinguishable by this method,
    so both names are given."""
    import numpy as np
    sr = 11025
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    y = np.frombuffer(raw[: len(raw) // 4 * 4], dtype=np.float32)
    n = 8192
    if len(y) < n * 4:
        return []
    freqs = np.fft.rfftfreq(n, 1 / sr)
    sel = (freqs > 65) & (freqs < 2000)
    pcs = (np.round(12 * np.log2(freqs[sel] / 440.0) + 69).astype(int)) % 12
    win = np.hanning(n)
    frames = []
    for i in range(0, len(y) - n, n // 2):
        mag = np.abs(np.fft.rfft(y[i:i + n] * win))[sel]
        c = np.bincount(pcs, weights=mag, minlength=12)
        frames.append(c / (c.sum() or 1))
    frames = np.array(frames)
    fps = sr / (n // 2)
    wf, hf = max(1, int(KEY_WINDOW * fps)), max(1, int(KEY_HOP * fps))
    profiles = []
    for k in range(12):
        profiles.append(np.roll(_MAJOR, k))
    for k in range(12):
        profiles.append(np.roll(_MINOR, k))
    profiles = np.array(profiles)
    starts = list(range(0, max(1, len(frames) - wf // 2), hf))
    scores = []
    for s0 in starts:
        c = frames[s0:s0 + wf].mean(axis=0)
        scores.append([np.corrcoef(p, c)[0, 1] for p in profiles])
    scores = np.nan_to_num(np.array(scores))
    # Major and its relative minor share the same notes and can't be told apart this way, so track the
    # 12 "key signatures" (a major key and its relative minor count as one) and name the mode afterwards.
    pair = np.zeros((len(scores), 12))
    for k in range(12):                       # k = tonic of the major key; relative minor is k + 9
        pair[:, k] = np.maximum(scores[:, k], scores[:, 12 + (k + 9) % 12])
    # Moving to a neighbouring key on the circle of fifths (e.g. Eb to Bb) is usually just the chords
    # leaning toward the 5th, not a real modulation, so it costs extra. Gospel/pop modulations are
    # typically up a semitone or tone, which are not neighbours.
    cost = np.zeros((12, 12))
    for a_ in range(12):
        for b_ in range(12):
            if a_ != b_:
                fifths = min((a_ * 7 - b_ * 7) % 12, (b_ * 7 - a_ * 7) % 12)  # steps apart on the circle of fifths
                cost[a_, b_] = KEY_SWITCH_COST * (3 if fifths == 1 else 1)
    best = pair[0].copy(); back = []
    for row in pair[1:]:
        trans = best[:, None] - cost          # [from, to]
        back.append(trans.argmax(axis=0))
        best = trans.max(axis=0) + row
    state = int(best.argmax()); path_ = [state]
    for b in reversed(back):
        state = int(b[state]); path_.append(state)
    path_.reverse()
    segs = []                                  # [start, key class, first window, last window]
    for i, (idx, st) in enumerate(zip(starts, path_)):
        if not segs or segs[-1][1] != st:
            segs.append([idx / fps, st, i, i])
        else:
            segs[-1][3] = i
    total = len(y) / sr
    merged = []                                # drop segments shorter than KEY_MIN_SEGMENT
    for i, seg in enumerate(segs):
        end = segs[i + 1][0] if i + 1 < len(segs) else total
        if merged and end - seg[0] < KEY_MIN_SEGMENT:
            merged[-1][3] = seg[3]
            continue
        if merged and merged[-1][1] == seg[1]:
            merged[-1][3] = seg[3]
            continue
        merged.append(seg)
    if merged:
        merged[0][0] = 0.0
    named = []
    for t, st, i0, i1 in merged:               # major or minor: whichever fits that stretch better
        maj = scores[i0:i1 + 1, st].mean()
        mnr = scores[i0:i1 + 1, 12 + (st + 9) % 12].mean()
        named.append((t, st if maj >= mnr else 12 + (st + 9) % 12))
    merged = named
    out = []
    for t, st in merged:
        tonic = st % 12
        if st < 12:
            key, rel = f"{KEY_NAMES[tonic]} major", f"{KEY_NAMES[(tonic + 9) % 12]} minor"
        else:
            key, rel = f"{KEY_NAMES[tonic]} minor", f"{KEY_NAMES[(tonic + 3) % 12]} major"
        out.append({"start": round(t, 1), "key": key, "rel": rel})
    return out


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
        if only_missing and entry and entry.get("size") == (folder / name).stat().st_size \
                and ("keys" in entry or not have_numpy()):
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
