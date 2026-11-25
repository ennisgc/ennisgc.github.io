// Renders a song page from song.json + lyrics.txt in the same folder.
(async function () {
  const app = document.getElementById('app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mime = f => /\.m4a$/i.test(f) ? 'audio/mp4' : /\.wav$/i.test(f) ? 'audio/wav' : 'audio/mpeg';

  const loadScript = src => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
  const WAVESURFER = 'https://cdn.jsdelivr.net/npm/wavesurfer.js@7.12.12/dist/';

  // Keyboard, waveform players and note detection. Each step is optional: if the CDN is
  // unreachable the basic <audio> controls already on the page keep working.
  async function loadExtras(song) {
    loadScript('../../keyboard.js').catch(console.warn);
    try {
      const peaks = fetch('peaks.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
      await loadScript(WAVESURFER + 'wavesurfer.min.js');
      await loadScript(WAVESURFER + 'plugins/regions.min.js');
      await loadScript('../../player.js');
      window.initPlayers(await peaks);
    } catch (e) {
      console.warn('Using basic audio players:', e.message);
    }
  }

  try {
    const song = await (await fetch('song.json')).json();
    const lyrics = song.lyrics ? await (await fetch(song.lyrics)).text() : '';
    document.title = song.title + ' – Choir Songs';

    const sections = (song.sections || []).map(sec => `
      <h3 class="mt-4">${esc(sec.heading)}</h3>
      ${sec.tracks.map(t => `
        <div class="card p-2 mb-3 track" data-file="${esc(t.file)}" data-label="${esc(t.label)}"
             data-kind="${/^line tapes/i.test(sec.heading) ? 'line' : 'rec'}">
          <h4>${esc(t.label)}</h4>
          <div class="player-host">
            <audio controls preload="none" class="w-100 mt-2">
              <source src="${esc(t.file)}" type="${mime(t.file)}">
              Your browser does not support the audio element.
            </audio>
          </div>
        </div>`).join('')}`).join('');

    const videos = (song.videos || []).map(v => `
      <div class="ratio ratio-16x9 mb-3">
        <iframe src="https://www.youtube.com/embed/${esc(v.id)}" title="${esc(v.title || song.title)}" allowfullscreen></iframe>
      </div>`).join('');

    app.innerHTML = `
      <div class="row g-3 my-3 align-items-center justify-content-between">
        <div class="col-12 col-md-3 d-flex flex-wrap gap-2">
          <a href="../../" class="btn btn-secondary mb-3">Back to Song List</a>
          <button type="button" class="btn btn-outline-primary mb-3" data-bs-toggle="offcanvas" data-bs-target="#keyboardOffcanvas" aria-controls="keyboardOffcanvas">
            <svg viewBox="0 0 24 16" width="22" height="14" class="me-1" aria-hidden="true"><rect x="0.75" y="0.75" width="22.5" height="14.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1v14M12 1v14M18 1v14" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 1h3v8h-3zM10.5 1h3v8h-3zM16.5 1h3v8h-3z" fill="currentColor"/></svg>Keyboard
          </button>
        </div>
        <div class="col-6 col-md-6 text-center"><h1 class="mb-3">${esc(song.title)}</h1></div>
        <div class="col-6 col-md-3 text-center text-md-end">
          <button class="btn btn-primary mx-auto mb-3 d-lg-none" data-bs-toggle="offcanvas" data-bs-target="#lyricsOffcanvas" aria-controls="lyricsOffcanvas"><span class="h2">View Lyrics</span></button>
        </div>
      </div>
      <div class="row song-layout">
        <div class="col-12 col-lg-7 song-main">
          ${sections}
          ${videos ? '<h3 class="mt-4">Full Song</h3>' + videos : ''}
        </div>
        <div class="lyrics-col col-lg-5">
          <div class="offcanvas-lg offcanvas-end lyrics-panel" id="lyricsOffcanvas" tabindex="-1" aria-labelledby="lyricsOffcanvasLabel">
            <div class="offcanvas-header">
              <h3 id="lyricsOffcanvasLabel">Lyrics</h3>
              <button type="button" class="btn-close" data-bs-dismiss="offcanvas" data-bs-target="#lyricsOffcanvas" aria-label="Close"></button>
            </div>
            <div class="offcanvas-body">
              <p><strong>S</strong>oprano  <strong>A</strong>lto  <strong>M</strong>en</p>
              <pre class="bg-light p-3 rounded">${esc(lyrics)}</pre>
            </div>
            <div class="offcanvas-footer d-lg-none p-3 text-center">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="offcanvas" data-bs-target="#lyricsOffcanvas">Close</button>
            </div>
          </div>
        </div>
      </div>`;
    initLyricsControls();
    loadExtras(song);
  } catch (e) {
    console.error(e);
    app.innerHTML = '<div class="alert alert-danger my-4">Could not load this song. If you opened the file directly, run a local server (e.g. <code>python3 -m http.server</code>).</div>';
  }
})();
