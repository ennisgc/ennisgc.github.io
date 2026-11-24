// Lyrics text-size controls. Called by song.js after the lyrics panel is rendered.
function initLyricsControls() {
  const body = document.querySelector('#lyricsOffcanvas .offcanvas-body');
  const lyricsText = document.querySelector('#lyricsOffcanvas pre');
  if (!body || !lyricsText || document.querySelector('.text-size-controls')) return;

  const MIN = 0.6, MAX = 2.5, DEFAULT = 1;
  const bar = document.createElement('div');
  bar.className = 'text-size-controls lyrics-toolbar d-flex align-items-center';

  function makeButton(text, title, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-outline-secondary btn-sm ' + extraClass;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }
  const increaseBtn = makeButton('A+', 'Increase text size', 'me-2');
  const decreaseBtn = makeButton('A-', 'Decrease text size', 'me-2');
  const resetBtn = makeButton('Reset', 'Reset text size', '');
  bar.append(increaseBtn, decreaseBtn, resetBtn);
  body.insertBefore(bar, body.firstChild);

  let size = parseFloat(localStorage.getItem('lyricsTextSize')) || DEFAULT;

  function apply(newSize, save) {
    size = Math.round(newSize * 10) / 10;
    lyricsText.style.fontSize = size + 'rem';
    decreaseBtn.disabled = size <= MIN;
    increaseBtn.disabled = size >= MAX;
    if (save) localStorage.setItem('lyricsTextSize', size);
  }

  decreaseBtn.addEventListener('click', () => size > MIN && apply(size - 0.1, true));
  increaseBtn.addEventListener('click', () => size < MAX && apply(size + 0.1, true));
  resetBtn.addEventListener('click', () => apply(DEFAULT, true));
  apply(size, false);
}
