// Two-octave tappable keyboard in an offcanvas that slides in from the left.
// Works with the mouse, touch (several fingers at once, and gliding) and the computer keyboard.
(function () {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const KEYS = 25;                 // C to C, two octaves
  const MIN_START = 24, MAX_START = 60; // lowest C is C1..C4
  const COMPUTER_KEYS = 'awsedftgyhujkolp;'.split(''); // a=C ... ;=E (one octave and a bit)

  const getCtx = () => (window.__choirCtx ||= new (window.AudioContext || window.webkitAudioContext)());
  const freq = midi => 440 * Math.pow(2, (midi - 69) / 12);
  const name = midi => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

  let start = 48; // C3
  let volume = 0.5;
  const voices = new Map(); // id -> {osc, gain, midi}

  // ---------- sound ----------
  // Every instrument is a function (ctx, out, midi, t0) -> { release(now) } built from Web Audio
  // nodes, so nothing needs downloading. LEVEL evens out loudness between instruments.
  const INSTRUMENTS = { piano: 'Piano', choir: 'Choir (ah)', midi: 'MIDI synth' };
  const LEVEL = { piano: 0.5, choir: 0.4, midi: 1.0 };
  let instrument = localStorage.getItem('keyboardInstrument');
  if (!INSTRUMENTS[instrument]) instrument = 'piano'; // piano unless you picked another before

  let noiseBuf = null;
  const noise = ctx => {
    if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  };

  // Piano: inharmonic partials that each decay at their own rate, two slightly detuned strings on
  // the lowest partials (gives the slow shimmer), and a short hammer thump.
  function buildSynthPiano(ctx, out, midi, t0) {
    const f0 = freq(midi);
    const voice = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(9000, f0 * 12 + 1200);
    tone.connect(voice); voice.connect(out);
    const B = Math.min(0.0012, 0.00015 * Math.pow(f0 / 261.6, 1.6)); // string stiffness
    const decay = Math.min(7, Math.max(0.9, 3.2 * Math.pow(f0 / 261.6, -0.55)));
    const oscs = [];
    for (let n = 1; n <= 14; n++) {
      const fn = f0 * n * Math.sqrt(1 + B * n * n);
      if (fn > 8500) break;
      const amp = 0.55 / Math.pow(n, 1.1) * (n === 2 ? 1.15 : 1);
      const tau = decay / (1 + 0.75 * (n - 1));
      const strings = n <= 3 ? [-1.4, 1.4] : [0];
      strings.forEach(det => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = fn; o.detune.value = det;
        const peak = amp / strings.length;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
        g.gain.setTargetAtTime(0, t0 + 0.004, tau);
        o.connect(g); g.connect(tone); o.start(t0);
        oscs.push(o);
      });
    }
    const thump = ctx.createBufferSource(), tf = ctx.createBiquadFilter(), tg = ctx.createGain();
    thump.buffer = noise(ctx);
    tf.type = 'bandpass'; tf.frequency.value = Math.min(4500, f0 * 3); tf.Q.value = 1.1;
    tg.gain.setValueAtTime(0.35, t0); tg.gain.setTargetAtTime(0, t0, 0.012);
    thump.connect(tf); tf.connect(tg); tg.connect(voice); thump.start(t0);
    return {
      release(now) { // damper falls on the strings
        voice.gain.cancelScheduledValues(now);
        voice.gain.setValueAtTime(voice.gain.value, now);
        voice.gain.setTargetAtTime(0, now, 0.07);
        oscs.forEach(o => o.stop(now + 0.6));
      },
    };
  }

  // Sampled piano (Salamander Grand, CC-BY 3.0, see samples/piano/README.txt): a real recording every
  // minor third, pitch-shifted a few semitones to fill the gaps. Falls back to the synthesised piano
  // above until the samples have loaded (or if they can't).
  const SAMPLE_NOTES = {};
  [['C', 0], ['Ds', 3], ['Fs', 6], ['A', 9]].forEach(([n, semi]) => {
    for (let oct = 1; oct <= 6; oct++) {
      const m = 12 * (oct + 1) + semi;
      if ((oct === 1 && n !== 'A') || (oct === 6 && n !== 'C')) continue;
      SAMPLE_NOTES[m] = `${n}${oct}`;
    }
  });
  const sampleBuffers = {}; // midi -> AudioBuffer
  const sampleGain = {};    // midi -> factor that brings every recording to the same peak level
  const normaliser = buf => {
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
    return peak ? 1 / peak : 1;
  };
  let samplesState = 'idle';
  function loadPianoSamples() {
    if (samplesState !== 'idle') return;
    samplesState = 'loading';
    const ctx = getCtx();
    const base = new URL('samples/piano/', document.querySelector('script[src$="keyboard.js"]').src).href;
    Promise.all(Object.entries(SAMPLE_NOTES).map(([m, name]) =>
      fetch(base + name + '.mp3').then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
        .then(buf => { sampleBuffers[m] = buf; sampleGain[m] = normaliser(buf); })))
      .then(() => { samplesState = 'ready'; })
      .catch(e => { samplesState = 'failed'; console.warn('Piano samples unavailable, using synthesised piano', e); });
  }
  function buildPiano(ctx, out, midi, t0) {
    const keys = Object.keys(sampleBuffers).map(Number);
    if (samplesState !== 'ready' || !keys.length) return buildSynthPiano(ctx, out, midi, t0);
    const root = keys.reduce((a, b) => Math.abs(b - midi) < Math.abs(a - midi) ? b : a);
    const src = ctx.createBufferSource(), env = ctx.createGain();
    src.buffer = sampleBuffers[root];
    src.playbackRate.value = Math.pow(2, (midi - root) / 12);
    env.gain.value = sampleGain[root];
    src.connect(env); env.connect(out); src.start(t0);
    return {
      release(now) { // damper falls on the strings
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(env.gain.value, now);
        env.gain.setTargetAtTime(0, now, 0.12);
        src.stop(now + 1.2);
      },
    };
  }

  // Choir: three detuned saw waves with a gentle vibrato, shaped by "ah" vowel formants, with a
  // soft attack so it swells in like voices do.
  function buildChoir(ctx, out, midi, t0) {
    const f0 = freq(midi);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.2);
    const warmth = ctx.createBiquadFilter();
    warmth.type = 'lowpass'; warmth.frequency.value = 5500;
    warmth.connect(env); env.connect(out);
    const sum = ctx.createGain(); sum.gain.value = 1;
    [[700, 6, 1.0], [1150, 8, 0.6], [2750, 10, 0.3], [3400, 12, 0.12]].forEach(([fc, q, g]) => {
      const bp = ctx.createBiquadFilter(), gain = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = Math.max(fc, f0 * 1.05); bp.Q.value = q;
      gain.gain.value = g * 5;
      sum.connect(bp); bp.connect(gain); gain.connect(warmth);
    });
    const vib = ctx.createOscillator(), vibAmt = ctx.createGain();
    vib.frequency.value = 5.2;
    vibAmt.gain.setValueAtTime(0, t0);
    vibAmt.gain.linearRampToValueAtTime(9, t0 + 0.9); // vibrato fades in
    vib.connect(vibAmt); vib.start(t0);
    const oscs = [vib];
    [-10, 0, 10].forEach(det => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f0; o.detune.value = det;
      vibAmt.connect(o.detune);
      const g = ctx.createGain(); g.gain.value = 0.33;
      o.connect(g); g.connect(sum); o.start(t0);
      oscs.push(o);
    });
    return {
      release(now) {
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(env.gain.value, now);
        env.gain.setTargetAtTime(0, now, 0.12);
        oscs.forEach(o => o.stop(now + 0.9));
      },
    };
  }

  // MIDI synth: the plain, bright tone (triangle plus a quiet octave) you hear from a basic MIDI player.
  function buildMidi(ctx, out, midi, t0) {
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
    const gain = ctx.createGain(), filter = ctx.createBiquadFilter(), mix2 = ctx.createGain();
    osc.type = 'triangle'; osc2.type = 'sine';
    osc.frequency.value = freq(midi); osc2.frequency.value = freq(midi) * 2;
    mix2.gain.value = 0.25;
    filter.type = 'lowpass'; filter.frequency.value = 3500;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.6);
    osc.connect(filter); osc2.connect(mix2); mix2.connect(filter);
    filter.connect(gain); gain.connect(out);
    osc.start(t0); osc2.start(t0);
    return {
      release(now) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        osc.stop(now + 0.2); osc2.stop(now + 0.2);
      },
    };
  }
  const BUILD = { piano: buildPiano, choir: buildChoir, midi: buildMidi };

  function noteOn(id, midi, inst = instrument) {
    noteOff(id);
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const master = ctx.createGain();
    master.gain.value = volume * LEVEL[inst];
    master.connect(ctx.destination);
    const voice = BUILD[inst](ctx, master, midi, ctx.currentTime);
    voices.set(id, { voice, master, midi, inst });
    light(midi, true);
  }
  function noteOff(id) {
    const v = voices.get(id);
    if (!v) return;
    voices.delete(id);
    v.voice.release(getCtx().currentTime);
    setTimeout(() => v.master.disconnect(), 1500); // after the release tail has faded
    if (![...voices.values()].some(o => o.midi === v.midi)) light(v.midi, false);
  }
  function allOff() { [...voices.keys()].forEach(noteOff); }

  // Offline render used for checking levels (not used by the page itself).
  function renderTest(inst, midi, seconds = 2) {
    const ctx = new OfflineAudioContext(1, Math.floor(44100 * seconds), 44100);
    const master = ctx.createGain();
    master.gain.value = LEVEL[inst];
    master.connect(ctx.destination);
    BUILD[inst](ctx, master, midi, 0);
    return ctx.startRendering().then(buf => {
      const d = buf.getChannelData(0);
      let peak = 0, sq = 0;
      for (let i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); sq += d[i] * d[i]; }
      return { peak: +peak.toFixed(3), rms: +Math.sqrt(sq / d.length).toFixed(4) };
    });
  }

  // ---------- DOM ----------
  const panel = document.createElement('div');
  panel.className = 'offcanvas offcanvas-start keyboard-panel';
  panel.id = 'keyboardOffcanvas';
  panel.tabIndex = -1;
  panel.setAttribute('data-bs-backdrop', 'false'); // keep the page usable while it is open
  panel.setAttribute('data-bs-scroll', 'true');
  panel.setAttribute('aria-labelledby', 'keyboardOffcanvasLabel');
  panel.innerHTML = `
    <div class="offcanvas-header">
      <h3 id="keyboardOffcanvasLabel" class="mb-0">Keyboard</h3>
      <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
    </div>
    <div class="offcanvas-body">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <label class="d-flex align-items-center gap-1 small">Sound
          <select class="form-select form-select-sm instrument w-auto" aria-label="Instrument sound">
            ${Object.entries(INSTRUMENTS).map(([k, v]) => `<option value="${k}"${k === instrument ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <button type="button" class="btn btn-outline-secondary btn-sm oct-down" aria-label="Down an octave">Octave -</button>
        <span class="small range-label fw-bold"></span>
        <button type="button" class="btn btn-outline-secondary btn-sm oct-up" aria-label="Up an octave">Octave +</button>
        <label class="d-flex align-items-center gap-1 small ms-auto">Volume
          <input type="range" class="form-range vol" min="0" max="1" step="0.05" value="${volume}" style="width: 7rem">
        </label>
      </div>
      <div class="piano" role="group" aria-label="Piano keyboard"></div>
      <p class="small text-muted mt-3 mb-1 detected" aria-live="polite">Play a line tape and the note it is singing lights up here.</p>
      <p class="small text-muted mb-0">Computer keys: <kbd>A</kbd> <kbd>W</kbd> <kbd>S</kbd> <kbd>E</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>T</kbd> <kbd>G</kbd> <kbd>Y</kbd> <kbd>H</kbd> <kbd>U</kbd> <kbd>J</kbd> <kbd>K</kbd> play from the lowest C.</p>
    </div>`;
  document.body.appendChild(panel);

  const piano = panel.querySelector('.piano');
  const rangeLabel = panel.querySelector('.range-label');
  const detectedLabel = panel.querySelector('.detected');

  function build() {
    piano.innerHTML = '';
    const whites = [];
    for (let m = start; m < start + KEYS; m++) if (!BLACK.has(m % 12)) whites.push(m);
    const w = 100 / whites.length;
    whites.forEach(m => {
      const k = document.createElement('div');
      k.className = 'key white';
      k.dataset.midi = m;
      k.innerHTML = `<span>${m % 12 === 0 ? name(m) : NOTE_NAMES[m % 12]}</span>`;
      k.style.width = w + '%';
      piano.appendChild(k);
    });
    let whiteIndex = 0;
    for (let m = start; m < start + KEYS; m++) {
      if (!BLACK.has(m % 12)) { whiteIndex++; continue; }
      const k = document.createElement('div');
      k.className = 'key black';
      k.dataset.midi = m;
      k.setAttribute('aria-label', name(m));
      k.style.width = w * 0.6 + '%';
      k.style.left = whiteIndex * w - w * 0.3 + '%';
      piano.appendChild(k);
    }
    rangeLabel.textContent = `${name(start)} to ${name(start + KEYS - 1)}`;
    panel.querySelector('.oct-down').disabled = start <= MIN_START;
    panel.querySelector('.oct-up').disabled = start >= MAX_START;
  }
  function keyEl(midi) { return piano.querySelector(`.key[data-midi="${midi}"]`); }
  function light(midi, on) { const k = keyEl(midi); if (k) k.classList.toggle('down', on); }

  function shift(delta) { allOff(); start = Math.min(MAX_START, Math.max(MIN_START, start + delta)); build(); }
  panel.querySelector('.oct-down').addEventListener('click', () => shift(-12));
  panel.querySelector('.oct-up').addEventListener('click', () => shift(12));
  panel.querySelector('.instrument').addEventListener('change', e => {
    allOff();
    instrument = e.target.value;
    localStorage.setItem('keyboardInstrument', instrument);
  });
  panel.querySelector('.vol').addEventListener('input', e => { volume = parseFloat(e.target.value); });
  build();

  // ---------- pointer input (mouse + multi-touch + gliding) ----------
  const keyAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const k = el && el.closest && el.closest('.piano .key');
    return k ? parseInt(k.dataset.midi, 10) : null;
  };
  piano.addEventListener('pointerdown', e => {
    const midi = keyAt(e.clientX, e.clientY);
    if (midi == null) return;
    e.preventDefault();
    noteOn('p' + e.pointerId, midi);
  });
  piano.addEventListener('pointermove', e => {
    const v = voices.get('p' + e.pointerId);
    if (!v) return;
    const midi = keyAt(e.clientX, e.clientY);
    if (midi != null && midi !== v.midi) noteOn('p' + e.pointerId, midi); // glide to the next key
  });
  const release = e => noteOff('p' + e.pointerId);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  piano.addEventListener('contextmenu', e => e.preventDefault());

  // ---------- computer keyboard ----------
  const typing = t => t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'range';
  function open() { return panel.classList.contains('show'); }
  window.addEventListener('keydown', e => {
    if (!open() || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    const i = COMPUTER_KEYS.indexOf(e.key.toLowerCase());
    if (i < 0) return;
    e.preventDefault();
    if (start + i < start + KEYS) noteOn('k' + e.key.toLowerCase(), start + i);
  });
  window.addEventListener('keyup', e => noteOff('k' + e.key.toLowerCase()));
  panel.addEventListener('show.bs.offcanvas', () => document.body.classList.add('keyboard-open'));
  panel.addEventListener('hidden.bs.offcanvas', () => { document.body.classList.remove('keyboard-open'); allOff(); });
  window.addEventListener('blur', allOff);

  // ---------- show the note a line tape is singing ----------
  document.addEventListener('note-detected', e => {
    const { midi } = e.detail;
    piano.querySelectorAll('.key.detected').forEach(k => k.classList.remove('detected'));
    const k = keyEl(midi);
    if (k) k.classList.add('detected');
    detectedLabel.textContent = `Last note heard: ${name(midi)}` +
      (k ? '' : ' - outside this keyboard, try Octave - / +');
  });

  // Used by the note buttons on the audio players: always sounds as a piano, at the pitch given.
  const hold = (id, midi) => noteOn('ref-' + id, midi, 'piano');
  const releaseRef = id => noteOff('ref-' + id);

  (window.requestIdleCallback || setTimeout)(loadPianoSamples);
  window.choirKeyboard = { samplesReady: () => samplesState, hold, release: releaseRef, activeCount: () => voices.size, activeInstruments: () => [...voices.values()].map(v => v.inst), get start() { return start; }, get instrument() { return instrument; }, renderTest };
})();
