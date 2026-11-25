# Ennis Gospel Choir: song practice site

A static website (GitHub Pages, `ennisgc/ennisgc.github.io`, branch `main`) where choir members find, for each song: backing tracks, line tapes (one voice part at a time), practice recordings, a YouTube video and the lyrics. There is no server, no framework and no build step. Everything is plain HTML, CSS and JavaScript that runs in the browser, plus small Python tools for maintaining the data.

This file is written for both people and AI agents who need to change the site. **Read "Rules that matter" before editing.**

---

## 1. Quick map

```
index.html            Home page. Builds its lists from songs.json in the browser.
songs.json            Master list of songs (slug, title, genre) + performance list + its sort mode.
songs/<slug>/         ONE FOLDER PER SONG (this is where almost all content lives):
    index.html        Identical in every folder (a tiny shell). Never edit per song.
    song.json         Title, YouTube videos, audio tracks. Describes the page.
    lyrics.txt        Plain-text lyrics.
    *.mp3 / *.m4a     Audio (128 kbps max).
    peaks.json        Pre-computed waveform data for the audio above (generated, do not hand-edit).
songs/_template/      Copy this to start a song (or use tools/add-song.py).
song.js               Renders a song page from song.json + lyrics.txt (+ loads the player/keyboard).
player.js             Audio players: waveform, loop a section, speed, note detection, tap-a-note.
keyboard.js           Two-octave keyboard in a left-hand offcanvas (piano / choir / MIDI sounds).
script.js             Lyrics text-size buttons (A+, A-, Reset). Called by song.js.
styles.css            All custom CSS (Bootstrap 5.3.2 supplies the rest).
santa-hat.svg         Icon for Christmas genre chips (used instead of an emoji; see "Gotchas").
*.html (root)         Old-URL redirect stubs, e.g. jingle-bells.html -> songs/jingle-bells/. Keep them.
tools/                Python maintenance scripts (see section 5).
lyrics/, recordings/, LineTapes+Recordings.xlsx   Leftover source material, not used by the site.
```

Genre codes used throughout: `X` = Christmas, `G` = Gospel, `Co` = Contemporary.

## 2. How the site works

**Home page (`index.html`)** fetches `songs.json` and draws:
- *Current Performance List*: the songs named in `songs.json -> performance`. Alphabetical unless `"performanceOrder": "custom"`, in which case the array order is kept (for a strict set list).
- *All Songs*: every song, always alphabetical, with genre filter buttons and a text filter.
- Two accordions at the top: **Latest Updates** (hand-written HTML, newest first, split Content / Technical, each item dated) and **Song Status** (a table built in the browser by reading every `song.json` and `lyrics.txt`: green Yes / red No for backing track, recording, soprano/alto/men line tape, video, lyrics).

**Song page** (`songs/<slug>/index.html`) is a shell that loads `song.js`, which:
1. fetches `song.json` and `lyrics.txt` from the same folder,
2. renders the title row, one card per audio track (starts as a plain `<audio controls>`), the YouTube embeds and the lyrics panel,
3. loads `keyboard.js`, then wavesurfer.js (CDN, pinned `7.12.12`) + its Regions plugin, then `player.js`, and calls `initPlayers(peaks)`.

If a CDN script fails, the plain `<audio>` controls remain and the page still works. That is deliberate.

**Lyrics panel**: on screens >= 992 px it is a sticky side column; below that it is a full-width offcanvas opened by "View Lyrics". It is one element using Bootstrap's `offcanvas-lg`.

**Players (`player.js`)** for each track:
- Waveform drawn from `peaks.json`, so the audio file is not downloaded until the user presses play.
- Drag on the waveform to pick a section; it loops until "Clear" or the "Loop on/off" toggle is turned off. One section at a time.
- Speed 0.5x to 1.25x (pitch preserved), -5 s / +5 s, only one player plays at a time.
- **Line tapes** (`data-kind="line"`) have live pitch detection (YIN autocorrelation on a Web Audio `AnalyserNode`). The last steady note shows as a button (stays, dimmed, after pause), and every note is also drawn in a **note lane** under the waveform: one bar per note, higher pitch = higher bar, tap or hold a bar to hear it on the piano (via `choirKeyboard.hold()`). Only the note NAME is kept and shown (no octave: the octave is the detector's weakest guess). Notes are stored per 0.1 s slot of the song, so replaying a part doesn't add extra bars; a stored note is only replaced by one 3+ semitones away (circular pitch-class distance) seen 4 readings in a row. Bar height uses a tracked octave (each note takes the octave nearest the previous one) so the melody keeps its shape; tapping a bar or the note button plays the note at that tracked (suggested) octave, though only the name is ever shown. "Clear notes" empties the lane. Each tape's voice range is limited by its label (`FMIN`/`FMAX`: soprano 200-1100 Hz, alto 150-700, men 80-450) so piano bass/overtones on piano+voice tapes are ignored. No tuning numbers are shown: a `?` after the name means the pitch is more than `UNSURE_CENTS` (30) from the nearest note. Measured: finds a pitch in about 85-90% of windows on clean tapes, only 15-25% on piano+voice tapes (O Holy Night).
- **Backing tracks and recordings** have no live note detection (measured: it found a pitch in about 7% of windows and mostly followed the bass). They show an **estimated key line** instead, with a button per key section that jumps to it. The key data is computed by `tools/audio.py: compute_keys` (numpy; chroma in 20 s windows matched to Krumhansl-Kessler profiles, smoothed so a change must last 25 s+ and a move to a neighbouring key on the circle of fifths (e.g. Eb to Bb, usually just chords leaning to the 5th) costs extra, relative major/minor reported together) and stored as `keys` in each track's entry of `peaks.json`. Without numpy the key line is just left out.
- `note-detected` events light the matching key on the keyboard.

**Keyboard (`keyboard.js`)**: opens from the left. On screens >= 992 px it adds `body.keyboard-open`, which shifts the page right by the panel width (520 px) and stacks the lyrics under the players, so nothing is covered; on phones it is a full-screen overlay. 25 keys (two octaves, C to C), octave shift, volume, Sound selector (Piano default, Choir (ah), MIDI synth; remembered in `localStorage.keyboardInstrument`). Mouse, multi-touch with gliding, and computer keys (A W S E D F T G Y H U J K ...) when the panel is open. Choir and MIDI are synthesised with Web Audio. The Piano uses real recordings (Salamander Grand, CC-BY 3.0, 1.4 MB in `samples/piano/`, one every minor third, pitch-shifted between, loaded when the browser is idle); until they load, or if they fail, it falls back to a synthesised piano (`buildSynthPiano`). `LEVEL` in the file balances loudness between instruments (measured with an offline render via `choirKeyboard.renderTest`).

## 3. Data formats

`songs.json`
```json
{
  "performanceOrder": "alphabetical",          // or "custom"
  "songs": [ { "slug": "jingle-bells", "title": "Jingle Bells", "genre": "X" } ],
  "performance": ["jingle-bells", "..."]        // slugs; order matters only when "custom"
}
```

`songs/<slug>/song.json`
```json
{
  "title": "Jingle Bells",
  "videos": [ { "id": "11-char-YouTube-id", "title": "Jingle Bells" } ],
  "sections": [
    { "heading": "Backing Tracks / Recordings",
      "tracks": [ { "label": "Backing Track", "file": "backing-track.mp3" } ] },
    { "heading": "Line Tapes",
      "tracks": [ { "label": "Soprano", "file": "line-tape-soprano.mp3" } ] }
  ],
  "lyrics": "lyrics.txt"
}
```
- A section whose heading starts with `Line Tapes` gets note detection and counts for the status table's Soprano/Alto/Men columns (label is matched on the words soprano, alto, men; "Men & Soprano" counts as both).
- Backing track = label containing "backing track" (or "all tracks mixed"); recording = label containing "recording".
- `peaks.json` maps file name -> `{ "size": bytes, "duration": s, "peaks": [500 numbers 0..1] }`. It is stale if `size` no longer matches the file.

## 4. Adding or changing content

**New song (normal route):**
```
python3 tools/add-song.py "Song Title" --genre X \
    --audio backing.mp3 alto.m4a men-soprano.wav \
    --video https://www.youtube.com/watch?v=XXXXXXXXXXX \
    --lyrics lyrics.txt --performance
python3 tools/check.py
```
It creates the folder, classifies/compresses/converts audio, writes `song.json`, `lyrics.txt`, `peaks.json`, registers the song in `songs.json` and prints what is still to do. Add `--dry-run` to preview. Then preview locally (below), commit and push.

**Change lyrics / video / labels:** edit `lyrics.txt` or `song.json` in the song folder. Nothing else to update.

**Add or replace audio manually:** put the file in the song folder, list it in `song.json`, then run `python3 tools/compress-audio.py` (fixes bitrate/format/damaged streams and rebuilds `peaks.json`) and `python3 tools/check.py --deep`.

**Update notes:** add a dated `<li>` at the top of the right column (Content or Technical) in the Latest Updates accordion in `index.html`. Use the real date.

**Local preview:** browsers block `fetch` on `file://`, so run `python3 -m http.server` in the repo root and open `http://localhost:8000/`. GitHub Pages needs nothing special; pushing to `main` publishes (allow a minute or two, then hard-refresh).

## 5. Tools (`tools/`, Python 3, need `ffmpeg`/`ffprobe` for audio)

| Command | What it does |
|---|---|
| `add-song.py` | Create a song (see above). |
| `compress-audio.py [--dry-run\|--check]` | Bring all audio to <= 128 kbps, turn `.wav`/`.mp4`/etc. into `.m4a`, re-encode files with damaged streams, update `song.json` renames, rebuild `peaks.json`. Idempotent. |
| `make-peaks.py [--all\|--check]` | Build/refresh `peaks.json` waveform data. |
| `check.py [--strict\|--deep]` | Validate everything. Errors fail (exit 1): missing files/folders, bad genre or YouTube id, `index.html` differing from the template, audio over 128 kbps, broken redirect stubs. Warnings: missing lyrics/video/audio, non-mp3/m4a audio, stale waveform data, unused or oddly named audio. `--deep` test-decodes every audio file (1-2 min). |

**Run `python3 tools/check.py` before every push.** Its warnings are the live to-do list for missing content (e.g. songs without a video); do not hard-code that list anywhere.

## 6. Rules that matter (read before editing)

1. **Do not hand-edit `songs/<slug>/index.html`.** All 34+ copies must equal `songs/_template/index.html` (`check.py` enforces this). Behaviour changes go in `song.js`, `player.js`, `keyboard.js`, `script.js` and `styles.css`.
2. **Audio must be 128 kbps or lower, and must decode cleanly.** Some recorder/phone AAC files have damaged streams (`ffmpeg` prints "Input buffer exhausted" / "Invalid data") and **Firefox refuses to play them** even though other browsers do. `compress-audio.py` and `add-song.py` re-encode those automatically; do not copy audio into a song folder by hand without running the tools.
3. **Audio is `.mp3` or `.m4a` only**, with safe file names (letters, digits, `.`, `-`). No spaces or special characters.
4. **Keep `peaks.json` in step with audio.** Changing an audio file without running `make-peaks.py` leaves a wrong waveform. `check.py` warns.
5. **GitHub Pages is case-sensitive.** `Foo.mp3` and `foo.mp3` are different files there (this broke a page once). Use lowercase slugs and file names.
6. **Do not use emoji for UI.** Some browsers (notably Brave on Linux without an emoji font) show empty squares. Use inline SVG or images (as `santa-hat.svg`, the keyboard icon, the play/pause icons).
7. **Do not remove the root `*.html` redirect stubs**; they keep old shared links working.
8. **Slug = folder name = key in `songs.json`.** Changing a slug breaks links; if you must, add a redirect stub.
9. **Pin CDN versions** (Bootstrap `5.3.2`, wavesurfer `7.12.12`). Floating tags (`@7`, `latest`) change under you (wavesurfer `latest` is already 8.x).
10. **Respect copyright:** the repo holds lyrics, so only add lyrics the choir has the right to use. Copyrighted songs' lyrics were supplied by the maintainer, not fetched from lyric sites.
11. **The git repo is large (audio).** `.git` was ~465 MB before the 128 kbps compression and keeps old versions. Avoid committing large or high-bitrate audio; GitHub recommends staying under ~1 GB.

## 7. Testing changes

There is no test suite. Use this routine:
- `python3 tools/check.py` (and `--deep` after audio changes).
- Serve with `python3 -m http.server`, open the index and a song page; check the browser console is clean.
- For interactive behaviour (loops, notes, keyboard), the approach that worked is **Selenium driving headless Firefox**: `pip install selenium` in a venv (Selenium Manager fetches geckodriver), set `media.autoplay.default=0`, and inspect state via `window.choirPlayers` (each has `.ws` wavesurfer, `.audio`) and `window.choirKeyboard` (`activeCount()`, `instrument`, `hold`, `release`, `renderTest`). Headless Firefox can play mp3/m4a here but screenshots can fire before async content loads (take two, or wait).
- Judge audio by measurement (offline render, peak/RMS) rather than by ear if you cannot listen.
- Check a narrow viewport (about 400 px wide) too; the layout must not scroll sideways.

## 8. Gotchas and history worth knowing

- The `X` (Christmas) chip is a green rounded chip with `santa-hat.svg` as its background and transparent text. The text stays (`X`) so filters can read `data-code`.
- The home page filter reads `data-code` on each chip, not its visible text.
- The Song Status table fetches every `song.json` and `lyrics.txt` on load (about 70 small requests); fine on Pages.
- `peaks.json` entries use 500 points; the player expands them to alternating +/- values for wavesurfer.
- `song.js` falls back gracefully (plain audio, no keyboard) if scripts or CDN fail; keep that property.
- Git identity used here: set per repo (`user.name`, `user.email`); pushes use `gh auth setup-git` credentials. Workflow files (`.github/workflows`) could not be pushed with the default token scopes (needs `gh auth refresh -s workflow`); no CI is set up, so `tools/check.py` is run by hand.
- Commits made with an AI assistant end with a `Co-Authored-By:` trailer.

## 9. Possible future work (not done)

- A GitHub Action running `tools/check.py` on every push (needs the `workflow` token scope).
- Web MIDI input from a real keyboard.
- One-time key detection per song for display (currently the nearest semitone is shown, deliberately not snapped to a key).
- Missing content is listed live by `python3 tools/check.py` (videos, lyrics, audio).


## Report an issue (Google Form)
`songs.json` has a `reportForm` block: `{"url": "<form viewform URL>", "songEntry": "entry.NNN", "pageEntry": "entry.NNN"}`. While `url` is empty the buttons stay hidden. When set, every song page shows a "Report an issue or leave a note" link at the top (like the home page) that opens the form in a new tab with the song title (and page URL, if `pageEntry` is set) pre-filled, and the home page shows a small link. To get the `entry.NNN` ids: in the Form choose the three-dot menu, "Get pre-filled link", fill the song field with any text, copy the link, and read the `entry.NNN=` names from it. Notifications and the passphrase question are set up in Google Forms, not here.
