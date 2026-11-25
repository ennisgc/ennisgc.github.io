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

    host.innerHTML = `
      <div class="wave" role="img" aria-label="Waveform of ${label.replace(/"/g, '')}"></div>
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
      <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <button type="button" class="btn btn-outline-secondary btn-sm loop" aria-pressed="false" disabled>Loop section</button>
        <button type="button" class="btn btn-outline-secondary btn-sm clear" disabled>Clear section</button>
        <span class="small text-muted section-info">Drag on the waveform to pick a section to repeat.</span>
        <div class="note-area ms-auto d-flex align-items-center flex-wrap justify-content-end gap-2">
          <span class="small text-muted">Note</span>
          <span class="note-history d-flex flex-wrap gap-1" aria-label="Recent notes"></span>
          <button type="button" class="note-chip" disabled title="${isLine ? 'The last note heard.' : 'The most prominent note heard (a best guess on a full mix).'} Tap to hear it on piano.">-</button>
        </div>
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
        : 'Drag on the waveform to pick a section to repeat.';
    }
    function setLoop(on) { loop = on; refreshSectionUI(); }
    function clearSection() {
      regions.getRegions().forEach(r => r.remove());
      region = null; loop = false; refreshSectionUI();
    }

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
      if (loop && region && t >= region.end - 0.03) { ws.setTime(region.start); if (self.resetNotes) self.resetNotes(); }
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

    // ---------- note detection ----------
    // Reliable on single-voice line tapes; on backing tracks and full-choir recordings it shows the
    // most prominent note, which is a best guess.
    const chip = $('.note-chip'), histEl = $('.note-history');
    let timer = null, analyser = null, buf = null, recent = [];
    let shown = null, shownUnsure = false, cand = null, candCount = 0, history = [];

    function renderHistory() { // earlier notes, oldest first; the big button is the current one
      if (!histEl) return;
      histEl.innerHTML = history.slice(0, -1).map(m =>
        `<button type="button" class="note-mini" data-midi="${m}" title="Tap to hear ${noteName(m)}">${noteName(m)}</button>`).join('');
    }
    function resetHistory() { history = []; renderHistory(); }
    function showNote(midi, cents) {
      const unsure = Math.abs(cents) > UNSURE_CENTS; // pitch sits between two notes: the name is a guess
      if (midi !== shown || unsure !== shownUnsure) {
        const newNote = midi !== shown;
        shown = midi; shownUnsure = unsure;
        chip.textContent = noteName(midi) + (unsure ? '?' : '');
        chip.dataset.midi = midi;
        chip.disabled = false;
        chip.setAttribute('aria-label', `Last note heard: ${noteName(midi)}${unsure ? ', not certain' : ''}. Tap to hear it.`);
        if (newNote) {
          if (history[history.length - 1] !== midi) {
            history.push(midi);
            if (history.length > 9) history.shift();
            renderHistory();
          }
          document.dispatchEvent(new CustomEvent('note-detected', { detail: { midi, unsure } }));
        }
      }
    }

    // Tap or hold a note button to hear it on the piano (sounds while held, like a key).
    const tapKey = 'player' + players.length;
    let tapping = false;
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
      const target = e => e.target.closest('.note-chip, .note-mini');
      const midiOf = el => parseInt(el.dataset.midi, 10);
      host.addEventListener('pointerdown', e => {
        const el = target(e);
        if (!el || el.disabled) return;
        e.preventDefault();
        tapStart(midiOf(el));
      });
      host.addEventListener('keydown', e => {
        const el = target(e);
        if (el && !el.disabled && !e.repeat && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); tapStart(midiOf(el)); }
      });
      host.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') tapStop(); });
      host.addEventListener('contextmenu', e => { if (target(e)) e.preventDefault(); });
      window.addEventListener('pointerup', tapStop);
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
      if (!chip || !ensureAnalyser()) return;
      const ctx = getCtx();
      if (ctx.state === 'suspended') ctx.resume();
      chip.classList.remove('stale');
      if (timer) return;
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        // a full mix has many notes at once, so only trust clear, strong readings there
        const f = isLine ? detectPitch(buf, getCtx().sampleRate)
                         : detectPitch(buf, getCtx().sampleRate, 0.13, 80, 800); // narrower range, stricter
        if (!f) return;
        const exact = 69 + 12 * Math.log2(f / 440);
        recent.push(exact); if (recent.length > 5) recent.shift();
        const mid = [...recent].sort((a, b) => a - b)[recent.length >> 1]; // median smooths glitches
        const midi = Math.round(mid), cents = Math.round((mid - midi) * 100);
        // only switch note once it has been steady for two readings, so the button doesn't flicker
        if (midi === cand) candCount++; else { cand = midi; candCount = 1; }
        if (candCount >= (isLine ? 2 : 3)) showNote(midi, cents); // mixes must hold a note a little longer
      }, 50);
    }
    function stopPitch() {
      if (timer) { clearInterval(timer); timer = null; }
      recent = []; cand = null; candCount = 0;
      if (chip) chip.classList.add('stale'); // keep the last note on screen, dimmed
    }
    self.resetNotes = resetHistory;

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
