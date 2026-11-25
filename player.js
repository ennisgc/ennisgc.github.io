// Audio players with waveform, section looping, speed control and note detection.
// Needs wavesurfer.js + its Regions plugin (loaded by song.js). If they are missing, the
// plain <audio controls> players that song.js renders stay in place.
(function () {
  const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MIN_SECTION = 0.3; // seconds; shorter drags are ignored
  const UNSURE_CENTS = 30; // more than this far from the nearest note (max possible is 50): show a '?'

  const ICON = {
    play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 2h3.2v12H3.5zM9.3 2h3.2v12H9.3z" fill="currentColor"/></svg>',
  };

  const getCtx = () => (window.__choirCtx ||= new (window.AudioContext || window.webkitAudioContext)());
  const fmt = s => {
    if (!isFinite(s)) s = 0;
    const m = Math.floor(s / 60);
    return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };
  const noteName = midi => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

  // ---------- pitch detection (YIN) ----------
  function detectPitch(buf, sr, threshold = 0.15, fmin = 70, fmax = 1000) {
    const W = buf.length >> 1;
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / buf.length) < 0.008) return null; // too quiet

    const tauMin = Math.floor(sr / fmax);
    const tauMax = Math.min(W - 1, Math.floor(sr / fmin));
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }
    // cumulative mean normalised difference
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running ? (d[tau] * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;
    // parabolic interpolation for a finer period estimate
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const denom = a + c - 2 * b;
      if (denom) better = tau + (a - c) / (2 * denom);
    }
    return sr / better;
  }

  // ---------- one player ----------
  let current = null;       // player that is playing right now
  const players = [];

  function makePlayer(card, peaksEntry) {
    const host = card.querySelector('.player-host');
    const file = card.dataset.file;
    const label = card.dataset.label;
    const isLine = card.dataset.kind === 'line';

    const keys = (peaksEntry && peaksEntry.keys) || [];
    // Overall key = the key that covers the most of the track; shown first, then where it changes.
    let keyLine = '';
    if (keys.length) {
      const dur = (peaksEntry && peaksEntry.duration) || 0;
      const span = {};
      keys.forEach((k, i) => { span[k.key] = (span[k.key] || 0) + ((keys[i + 1] ? keys[i + 1].start : dur || k.start + 1) - k.start); });
      const main = keys.reduce((a, k) => (span[k.key] > span[a.key] ? k : a), keys[0]);
      const hint = k => `Possible key: ${k.key} or ${k.rel} (they share the same notes). A best guess.`;
      const seg = k => `<button type="button" class="key-seg" data-start="${k.start}" title="${hint(k)} Click to jump here."><span class="text-muted">${fmt(k.start)}</span> ${k.key} <span class="text-muted">/ ${k.rel}</span></button>`;
      keyLine = `<div class="key-line small mt-2"><span class="text-muted">Possible key${keys.length > 1 ? ' (overall)' : ''}</span>
        <span class="key-main" title="${hint(main)}">${main.key} <span class="text-muted">/ ${main.rel}</span></span>${
        keys.length > 1 ? `<span class="text-muted ms-2">Possible changes:</span>${keys.map(seg).join('<span class="text-muted">&rarr;</span>')}` : ''}</div>`;
    }
    host.innerHTML = `
      <div class="wave" role="img" aria-label="Waveform of ${label.replace(/"/g, '')}"></div>
      ${isLine ? '<div class="note-lane" aria-label="Possible notes heard so far (best guesses). Tap one to hear it."><span class="lane-hint">Possible notes appear here as the tape plays (best guesses). Tap one to hear it.</span></div>' : ''}
      ${keyLine}
      <div class="player-controls d-flex flex-wrap align-items-center gap-2 mt-2">
        <button type="button" class="btn btn-primary btn-sm pp" aria-label="Play">${ICON.play}</button>
        <button type="button" class="btn btn-outline-secondary btn-sm back" aria-label="Back 5 seconds">-5s</button>
        <button type="button" class="btn btn-outline-secondary btn-sm fwd" aria-label="Forward 5 seconds">+5s</button>
        <span class="time small text-muted">0:00 / 0:00</span>
        <label class="d-flex align-items-center gap-1 small ms-auto">Speed
          <select class="form-select form-select-sm speed w-auto" aria-label="Playback speed">
            ${SPEEDS.map(s => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}x</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="loop-controls d-flex flex-wrap align-items-center gap-2 mt-2" role="group" aria-label="Loop controls">
        <span class="loop-title">Loop controls</span>
        <button type="button" class="btn btn-outline-secondary btn-sm tapmode" aria-pressed="false" title="Turn on, then tap the start and the end of the section on the waveform">Tap to set</button>
        <button type="button" class="btn btn-outline-secondary btn-sm loop" aria-pressed="false" disabled>Loop on/off</button>
        <button type="button" class="btn btn-outline-secondary btn-sm clear" disabled>Clear</button>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <span class="small text-muted section-info">Drag on the waveform to pick a section to repeat.</span>
        ${isLine ? `<div class="note-area ms-auto d-flex align-items-center flex-wrap justify-content-end gap-2">
          <button type="button" class="btn btn-link btn-sm p-0 clear-notes" disabled>Clear notes</button>
          <span class="small text-muted">Possible note</span>
          <button type="button" class="note-chip" disabled title="The last note the app thinks it heard (a best guess). Tap to hear it on piano.">-</button>
        </div>` : ''}
      </div>`;

    const $ = sel => host.querySelector(sel);
    const audio = new Audio();
    audio.preload = 'none';
    audio.src = file;

    const opts = {
      container: $('.wave'), media: audio, height: 64,
      waveColor: '#9aa8e8', progressColor: '#0000af', cursorColor: '#BE9F57', cursorWidth: 2,
      barWidth: 2, barGap: 1, barRadius: 2,
    };
    if (peaksEntry) { // draw straight from the pre-computed peaks: no audio download until play
      const alt = new Float32Array(peaksEntry.peaks.length * 2);
      peaksEntry.peaks.forEach((p, i) => { alt[2 * i] = p; alt[2 * i + 1] = -p; });
      opts.peaks = [alt];
      opts.duration = peaksEntry.duration;
    } else {
      opts.url = file; // no peaks file: fall back to decoding the audio
    }
    const ws = WaveSurfer.create(opts);
    const regions = ws.registerPlugin(WaveSurfer.Regions.create());
    regions.enableDragSelection({ color: 'rgba(190, 159, 87, 0.35)' });

    const self = { ws, audio, pause: () => ws.pause() };
    let region = null;
    let loop = false;
    let tapMode = false, pendingStart = null, marker = null, downX = 0;
    const loopBtn = $('.loop'), clearBtn = $('.clear'), info = $('.section-info'), timeEl = $('.time');

    const total = () => ws.getDuration() || (peaksEntry && peaksEntry.duration) || 0;
    const showTime = t => { timeEl.textContent = fmt(t) + ' / ' + fmt(total()); };
    showTime(0);

    function refreshSectionUI() {
      loopBtn.disabled = clearBtn.disabled = !region;
      loopBtn.classList.toggle('btn-warning', loop);
      loopBtn.classList.toggle('btn-outline-secondary', !loop);
      loopBtn.setAttribute('aria-pressed', String(loop));
      info.textContent = region
        ? `Section ${fmt(region.start)} - ${fmt(region.end)}${loop ? ' (repeating)' : ''}`
        : tapHint();
    }
    function tapHint() {
      if (!tapMode) return 'Drag on the waveform to pick a section to repeat, or use Tap to set.';
      return pendingStart === null ? 'Tap the waveform where the section starts.'
        : `Start ${fmt(pendingStart)}. Now tap where it ends.`;
    }
    function setLoop(on) { loop = on; refreshSectionUI(); }
    function clearMarker() { pendingStart = null; if (marker) { marker.remove(); marker = null; } }
    function clearSection() {
      clearMarker();
      regions.getRegions().forEach(r => r.remove());
      region = null; loop = false; refreshSectionUI();
    }

    // Tap mode: first tap sets the start, second tap sets the end and starts the loop.
    const waveEl = $('.wave'), tapBtn = $('.tapmode');
    function setTapMode(on) {
      tapMode = on;
      if (!on) clearMarker();
      ws.setOptions({ interact: !on }); // in tap mode a tap marks a point instead of seeking
      tapBtn.classList.toggle('btn-warning', on);
      tapBtn.classList.toggle('btn-outline-secondary', !on);
      tapBtn.setAttribute('aria-pressed', String(on));
      refreshSectionUI();
    }
    tapBtn.addEventListener('click', () => setTapMode(!tapMode));
    waveEl.addEventListener('pointerdown', e => { downX = e.clientX; });
    waveEl.addEventListener('click', e => {
      if (!tapMode || Math.abs(e.clientX - downX) > 4) return; // a drag is a drag-selection, not a tap
      const rect = waveEl.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total();
      if (pendingStart === null) {
        regions.getRegions().forEach(r => r.remove()); // starting a new section
        pendingStart = t;
        marker = document.createElement('div');
        marker.className = 'wave-marker';
        marker.style.left = (t / total() * 100) + '%';
        waveEl.appendChild(marker);
        refreshSectionUI();
        return;
      }
      const a = Math.min(pendingStart, t), b = Math.max(pendingStart, t);
      if (b - a < MIN_SECTION) { clearMarker(); pendingStart = t; return; }
      clearMarker();
      regions.addRegion({ start: a, end: b, color: 'rgba(190, 159, 87, 0.35)' }); // 'region-created' starts the loop
    });

    // Load the audio as soon as the pointer is over the player (or it is touched or focused),
    // so playing and looping start without a download delay.
    let warmed = false;
    const warm = () => { if (!warmed) { warmed = true; audio.preload = 'auto'; audio.load(); } };
    ['pointerenter', 'touchstart', 'focusin'].forEach(ev => card.addEventListener(ev, warm, { passive: true }));

    // A drag on the waveform fires 'region-created' once the drag ends; resizing or moving an
    // existing section fires 'region-updated'.
    regions.on('region-created', r => {
      regions.getRegions().filter(o => o !== r).forEach(o => o.remove()); // one section at a time
      if (r.end - r.start < MIN_SECTION) { r.remove(); return; }         // ignore accidental taps
      region = r;
      loop = true;
      refreshSectionUI();
      ws.setTime(r.start);
      ws.play();
    });
    regions.on('region-updated', r => {
      region = r;
      refreshSectionUI();
      if (ws.getCurrentTime() < r.start || ws.getCurrentTime() > r.end) ws.setTime(r.start);
    });
    regions.on('region-removed', r => { if (region === r) { region = null; loop = false; refreshSectionUI(); } });

    ws.on('timeupdate', t => {
      showTime(t);
      if (loop && region && t >= region.end - 0.03) { ws.setTime(region.start); }
    });
    ws.on('ready', () => showTime(ws.getCurrentTime()));
    ws.on('play', () => {
      if (current && current !== self) current.pause();
      current = self;
      $('.pp').innerHTML = ICON.pause; $('.pp').setAttribute('aria-label', 'Pause');
      startPitch();
    });
    ws.on('pause', () => {
      $('.pp').innerHTML = ICON.play; $('.pp').setAttribute('aria-label', 'Play');
      stopPitch();
    });
    ws.on('finish', () => { stopPitch(); });

    $('.pp').addEventListener('click', () => ws.playPause());
    $('.back').addEventListener('click', () => ws.skip(-5));
    $('.fwd').addEventListener('click', () => ws.skip(5));
    $('.speed').addEventListener('change', e => ws.setPlaybackRate(parseFloat(e.target.value), true));
    loopBtn.addEventListener('click', () => setLoop(!loop));
    clearBtn.addEventListener('click', clearSection);

    // ---------- note detection (line tapes only) ----------
    // Reliable on a single voice. Backing tracks and full recordings have no single note to follow, so
    // they get an estimated key line instead (from peaks.json), not live note detection.
    const chip = $('.note-chip'), lane = $('.note-lane'), clearNotes = $('.clear-notes');
    let timer = null, analyser = null, buf = null, recent = [];
    let shown = null, shownUnsure = false, cand = null, candCount = 0;

    // Voice range for this tape: ignoring pitches outside it stops the piano's bass and
    // overtones being mistaken for the voice. CENTER seeds the octave tracker below.
    const lab = label.toLowerCase();
    const both = /soprano/.test(lab) && /men|tenor|bass/.test(lab);
    const part = both ? { f: [70, 1100], center: 62 }
      : /soprano/.test(lab) ? { f: [200, 1100], center: 72 }
      : /alto/.test(lab) ? { f: [150, 700], center: 62 }
      : /men|tenor|bass/.test(lab) ? { f: [80, 450], center: 52 }
      : { f: [70, 1000], center: 62 };
    const [FMIN, FMAX] = part.f;
    const pcOf = m => ((m % 12) + 12) % 12;
    const pcName = pc => NOTE_NAMES[pc];                          // names only: the octave is too often wrong
    const playable = h => Math.max(36, Math.min(96, h));            // keep within the keyboard's sound range
    const pcDist = (a, b) => Math.min((a - b + 12) % 12, (b - a + 12) % 12);

    // Notes are kept per position in the song (0.1 s slots), so playing the same bit again doesn't pile
    // up extra notes. Only the note name is kept: the octave is the detector's weakest guess. A stored
    // note is replaced only by one at least 3 semitones away that shows up 4 readings in a row.
    // For bar height, each note takes whichever octave lands nearest the previous note, which keeps the
    // melody's shape without trusting the detected octave.
    const SLOT = 0.1, REPLACE_SEMITONES = 3, REPLACE_READINGS = 4;
    const slots = [];            // slot index -> {pc, h}  (h = tracked height in semitones)
    let pending = null;          // {slot, pc, n}
    let lastH = part.center;
    let drawQueued = false;
    function trackHeight(i, pc) {
      let ref = lastH;
      for (let k = i - 1; k >= Math.max(0, i - 30); k--) if (slots[k]) { ref = slots[k].h; break; }
      const h = pc + 12 * Math.round((ref - pc) / 12);
      lastH = h;
      return h;
    }
    // Returns the suggested (tracked) octave for this reading, as a midi note, so a tap can play it.
    function recordNote(t, midi) {
      const pc = pcOf(midi);
      const i = Math.floor(t / SLOT);
      const have = slots[i];
      if (have === undefined) {
        const h = trackHeight(i, pc);
        slots[i] = { pc, h }; pending = null; queueDraw();
        return h;
      }
      const near = (ref) => pc + 12 * Math.round((ref - pc) / 12);
      if (pcDist(pc, have.pc) < REPLACE_SEMITONES) { pending = null; return near(have.h); }
      if (pending && pending.pc === pc && Math.abs(pending.slot - i) <= 2) pending.n++;
      else pending = { slot: i, pc, n: 1 };
      if (pending.n >= REPLACE_READINGS) {
        const h = trackHeight(i, pc);
        for (let k = i - 1; k <= i + 1; k++) if (slots[k] !== undefined) slots[k] = { pc, h };
        slots[i] = { pc, h }; pending = null; queueDraw();
        return h;
      }
      return near(have.h);
    }
    function queueDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawLane); } }
    function drawLane() {
      drawQueued = false;
      if (!lane) return;
      const dur = total() || 1;
      const segs = [];           // consecutive slots with the same note become one bar
      for (let i = 0; i < slots.length; i++) {
        if (!slots[i]) continue;
        const last = segs[segs.length - 1];
        if (last && last.pc === slots[i].pc && i - last.endSlot <= 3) last.endSlot = i;
        else segs.push({ pc: slots[i].pc, h: slots[i].h, startSlot: i, endSlot: i });
      }
      lane.querySelector('.lane-hint')?.remove();
      lane.querySelectorAll('.note-seg').forEach(n => n.remove());
      clearNotes.disabled = !segs.length;
      if (!segs.length) { lane.insertAdjacentHTML('afterbegin', '<span class="lane-hint">Possible notes appear here as the tape plays (best guesses). Tap one to hear it.</span>'); return; }
      const lo = Math.min(...segs.map(g => g.h)), hi = Math.max(...segs.map(g => g.h));
      const rows = Math.max(hi - lo + 1, 5), H = lane.clientHeight || 56, rowH = (H - 4) / rows;
      const px = lane.clientWidth || 1;
      lane.insertAdjacentHTML('beforeend', segs.map(g => {
        const left = g.startSlot * SLOT / dur * 100, w = (g.endSlot - g.startSlot + 1) * SLOT / dur * 100;
        const top = 2 + (hi - g.h) * rowH;
        const wide = w / 100 * px >= 24;
        const name = pcName(g.pc);
        return `<span class="note-seg${wide ? ' labelled' : ''}" role="button" tabindex="0" data-midi="${playable(g.h)}" data-name="${name}" title="Possible note ${name}: tap to hear"` +
          ` aria-label="Possible note ${name}, tap to hear" style="left:${left}%;width:${w}%;top:${top}px;height:${Math.max(rowH - 1, 8)}px">${wide ? name : ''}</span>`;
      }).join(''));
    }
    function clearAllNotes() {
      slots.length = 0; pending = null; shown = null; lastH = part.center;
      chip.textContent = '-'; chip.disabled = true; delete chip.dataset.midi;
      drawLane();
    }
    if (clearNotes) clearNotes.addEventListener('click', clearAllNotes);

    function showNote(midi, cents, h) {
      const pc = pcOf(midi);
      const unsure = Math.abs(cents) > UNSURE_CENTS; // pitch sits between two notes: the name is a guess
      if (pc !== shown || unsure !== shownUnsure) {
        const newNote = pc !== shown;
        shown = pc; shownUnsure = unsure;
        chip.textContent = pcName(pc) + (unsure ? '?' : '');
        chip.dataset.midi = playable(h);
        chip.disabled = false;
        chip.setAttribute('aria-label', `Possible note: ${pcName(pc)}${unsure ? ', less certain' : ''}. Tap to hear it.`);
        if (newNote) document.dispatchEvent(new CustomEvent('note-detected', { detail: { midi: playable(h), unsure } }));
      }
    }

    // Key line: click a key to jump to where it starts.
    host.querySelectorAll('.key-seg').forEach(b => b.addEventListener('click', () => ws.setTime(parseFloat(b.dataset.start) || 0)));

    // Tap or hold a note button to hear it on the piano (sounds while held, like a key).
    const tapKey = 'player' + players.length;
    let tapping = false;
    let readoutTimer = null;
    function flash(el) { // say which note a tapped bar is, even if it's too narrow to carry a label
      if (!lane || !el || !el.classList.contains('note-seg')) return;
      let r = lane.querySelector('.lane-readout');
      if (!r) { r = document.createElement('span'); r.className = 'lane-readout'; lane.appendChild(r); }
      r.textContent = 'Possible note: ' + el.dataset.name;
      r.classList.add('on');
      lane.querySelectorAll('.note-seg.pressed').forEach(n => n.classList.remove('pressed'));
      el.classList.add('pressed');
      clearTimeout(readoutTimer);
    }
    function unflash() {
      clearTimeout(readoutTimer);
      readoutTimer = setTimeout(() => {
        if (!lane) return;
        lane.querySelector('.lane-readout')?.classList.remove('on');
        lane.querySelectorAll('.note-seg.pressed').forEach(n => n.classList.remove('pressed'));
      }, 1200);
    }
    function tapStart(midi) {
      if (!window.choirKeyboard || !isFinite(midi)) return;
      tapStop();
      tapping = true;
      window.choirKeyboard.hold(tapKey, midi);
    }
    function tapStop() {
      if (!tapping) return;
      tapping = false;
      window.choirKeyboard.release(tapKey);
    }
    if (chip) {
      const target = e => e.target.closest('.note-chip, .note-seg');
      const midiOf = el => parseInt(el.dataset.midi, 10);
      host.addEventListener('pointerdown', e => {
        const el = target(e);
        if (!el || el.disabled) return;
        e.preventDefault();
        tapStart(midiOf(el)); flash(el);
      });
      host.addEventListener('keydown', e => {
        const el = target(e);
        if (el && !el.disabled && !e.repeat && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); tapStart(midiOf(el)); flash(el); }
      });
      host.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { tapStop(); unflash(); } });
      host.addEventListener('contextmenu', e => { if (target(e)) e.preventDefault(); });
      window.addEventListener('pointerup', () => { tapStop(); unflash(); });
      window.addEventListener('pointercancel', tapStop);
      window.addEventListener('blur', tapStop);
    }

    function ensureAnalyser() {
      if (analyser) return true;
      try {
        const ctx = getCtx();
        const src = ctx.createMediaElementSource(audio);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        buf = new Float32Array(analyser.fftSize);
        src.connect(analyser);
        analyser.connect(ctx.destination);
        return true;
      } catch (e) { console.warn('Note detection unavailable', e); return false; }
    }
    function startPitch() {
      if (!isLine || !chip || !ensureAnalyser()) return;
      const ctx = getCtx();
      if (ctx.state === 'suspended') ctx.resume();
      chip.classList.remove('stale');
      if (timer) return;
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        // a full mix has many notes at once, so only trust clear, strong readings there
        const f = detectPitch(buf, getCtx().sampleRate, 0.2, FMIN, FMAX);
        if (!f) return;
        const exact = 69 + 12 * Math.log2(f / 440);
        recent.push(exact); if (recent.length > 5) recent.shift();
        const mid = [...recent].sort((a, b) => a - b)[recent.length >> 1]; // median smooths glitches
        const midi = Math.round(mid), cents = Math.round((mid - midi) * 100);
        // only count a note once it has been steady for two readings, so it doesn't flicker
        if (midi === cand) candCount++; else { cand = midi; candCount = 1; }
        if (candCount >= 2) { const h = recordNote(audio.currentTime, midi); showNote(midi, cents, h); }
      }, 50);
    }
    function stopPitch() {
      if (timer) { clearInterval(timer); timer = null; }
      recent = []; cand = null; candCount = 0;
      if (chip) chip.classList.add('stale'); // keep the last note on screen, dimmed
    }

    players.push(self);
    return self;
  }

  window.choirPlayers = players; // handy for debugging in the console

  window.initPlayers = function (peaks) {
    if (!window.WaveSurfer || !WaveSurfer.Regions) return;
    document.querySelectorAll('.track').forEach(card => {
      try {
        makePlayer(card, peaks[card.dataset.file.split('/').pop()]);
      } catch (e) {
        console.error('Player failed, keeping the basic audio control', e);
      }
    });
  };
})();
