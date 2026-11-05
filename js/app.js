import * as db from './db.js';
import { Session, deckCounts } from './study.js';
import { formatDuration } from './srs.js';
import { ACCEPT, parseSignName, videoType, naturalCompare } from './importer.js';
import { buildExport, shareOrDownload, importProgress } from './backup.js';

const app = document.getElementById('app');
const MODES = { both: 'Both', video2word: 'Sign → Word', word2video: 'Word → Sign' };

// ---------- small helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const byName = (a, b) => naturalCompare(a.name, b.name);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function bytes(n) {
  if (!n) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

const svg = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  chevron: svg('<path d="M9 18l6-6-6-6"/>'),
};

function header(title, { back, right } = {}) {
  return `<header class="bar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Back">${ICON.back}</a>` : '<span class="icon-btn"></span>'}
    <h1>${esc(title)}</h1>
    ${right || '<span class="icon-btn"></span>'}
  </header>`;
}

function countsHtml(c) {
  return `<span class="counts">
    <span class="c-new" title="New">${c.newCount}</span>
    <span class="c-learn" title="Learning">${c.learnCount}</span>
    <span class="c-due" title="To review">${c.reviewCount}</span>
  </span>`;
}

function modePicker() {
  const cur = ls.get('mode', 'both');
  return `<div class="segmented" role="radiogroup" aria-label="Study mode">
    ${Object.entries(MODES).map(([k, v]) => `<button type="button" role="radio" data-mode="${k}" aria-checked="${k === cur}">${v}</button>`).join('')}
  </div>`;
}
function bindModePicker() {
  $$('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      ls.set('mode', b.dataset.mode);
      $$('[data-mode]').forEach((o) => o.setAttribute('aria-checked', o === b));
    }),
  );
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

// ---------- video player ----------

const players = new Set();

function createPlayer(signId) {
  const wrap = document.createElement('div');
  wrap.className = 'player';
  wrap.innerHTML = `<video playsinline webkit-playsinline muted loop autoplay preload="auto"></video>
    <div class="player-controls">
      <button type="button" class="chip" data-act="replay">↺ Replay</button>
      <button type="button" class="chip" data-act="speed"></button>
    </div>`;
  const video = $('video', wrap);
  const speedBtn = $('[data-act=speed]', wrap);
  let url = null;
  let destroyed = false;

  const applyRate = () => {
    const r = ls.get('rate', 1);
    video.defaultPlaybackRate = r;
    video.playbackRate = r;
    speedBtn.textContent = `Speed ${r}×`;
  };
  applyRate();
  video.addEventListener('loadedmetadata', applyRate);
  video.addEventListener('click', () => (video.paused ? video.play().catch(() => {}) : video.pause()));
  wrap.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'replay') { video.currentTime = 0; video.play().catch(() => {}); }
    if (act === 'speed') {
      const rates = [1, 0.75, 0.5];
      ls.set('rate', rates[(rates.indexOf(ls.get('rate', 1)) + 1) % rates.length]);
      applyRate();
    }
  });

  db.get('videos', signId).then((rec) => {
    if (destroyed) return;
    if (!rec) {
      video.replaceWith(Object.assign(document.createElement('div'), { className: 'no-video', textContent: 'Video not found' }));
      return;
    }
    const blob = rec.data instanceof Blob ? rec.data : new Blob([rec.data], { type: rec.type || 'video/mp4' });
    url = URL.createObjectURL(blob);
    video.src = url;
    video.play().catch(() => {});
  });

  wrap.destroy = () => {
    destroyed = true;
    players.delete(wrap);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (url) URL.revokeObjectURL(url);
    wrap.remove();
  };
  players.add(wrap);
  return wrap;
}

// ---------- router ----------

let cleanups = [];
let routeToken = 0;

async function route() {
  for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
  for (const p of [...players]) p.destroy();
  const token = ++routeToken;
  const ctx = { alive: () => token === routeToken };
  const [path, qs = ''] = (location.hash.slice(1) || '/').split('?');
  const [name = '', ...args] = path.split('/').filter(Boolean);
  const view = VIEWS[name] || viewDecks;
  try {
    await view(ctx, args, new URLSearchParams(qs));
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (ctx.alive()) app.innerHTML = `${header('Oops', { back: '#/' })}<main class="page"><p class="error">Something went wrong: ${esc(err.message)}</p></main>`;
  }
}

// ---------- views ----------

async function viewDecks(ctx) {
  const decks = (await db.getAll('decks')).sort(byName);
  const rows = await Promise.all(decks.map(async (d) => ({ d, c: await deckCounts(d), n: await db.count('signs', 'deckId', d.id) })));
  if (!ctx.alive()) return;

  app.innerHTML = `
    ${header('Sign Cards', { right: `<a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>` })}
    <main class="page">
      ${rows.length ? `
        <ul class="list">
          ${rows.map(({ d, c, n }) => `
            <li class="deck-item">
              <a class="deck-main" href="#/deck/${d.id}">
                <span class="deck-name">${esc(d.name)}</span>
                <span class="muted">${plural(n, 'sign')}</span>
              </a>
              ${countsHtml(c)}
              <a class="btn small primary" href="#/study?decks=${d.id}">Study</a>
            </li>`).join('')}
        </ul>
        <p class="legend"><span class="c-new">new</span> · <span class="c-learn">learning</span> · <span class="c-due">to review</span></p>
        ${modePicker()}
        ${rows.length > 1 ? '<a class="btn primary block" href="#/study?decks=all">Study all decks</a>' : ''}
      ` : `
        <div class="empty">
          <div class="empty-icon">🤟</div>
          <h2>No decks yet</h2>
          <p>Import a collection of sign videos. Each video's file name becomes the sign's name.</p>
        </div>`}
      <a class="btn block" href="#/import">${ICON.plus} Import videos</a>
    </main>`;
  bindModePicker();
}

async function viewDeck(ctx, [id]) {
  const deck = await db.get('decks', Number(id));
  if (!deck) return location.replace('#/');
  const [signs, counts] = await Promise.all([db.getAll('signs', 'deckId', deck.id), deckCounts(deck)]);
  if (!ctx.alive()) return;
  signs.sort(byName);
  const signById = new Map(signs.map((s) => [s.id, s]));

  app.innerHTML = `
    ${header(deck.name, { back: '#/' })}
    <main class="page">
      <div class="stat-row">${countsHtml(counts)}<span class="muted">${plural(signs.length, 'sign')}</span></div>
      ${modePicker()}
      <a class="btn primary block" href="#/study?decks=${deck.id}">Study</a>
      <a class="btn block" href="#/import/${deck.id}">${ICON.plus} Add videos</a>

      <h2 id="signsTitle">Signs (${signs.length})</h2>
      <input type="search" id="search" placeholder="Search signs" autocomplete="off">
      <ul class="list sign-list" id="signs">
        ${signs.map((s) => `
          <li data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}">
            <button type="button" class="sign-row"><span class="sign-name">${esc(s.name)}</span>${ICON.chevron}</button>
            <div class="sign-detail" hidden></div>
          </li>`).join('')}
      </ul>

      <h2>Deck settings</h2>
      <label class="field"><span>New signs per day</span>
        <input type="number" id="npd" inputmode="numeric" min="0" max="999" value="${deck.newPerDay ?? 10}">
      </label>
      <button type="button" class="btn block" id="rename">Rename deck</button>
      <button type="button" class="btn danger block" id="delete">Delete deck</button>
    </main>`;
  bindModePicker();

  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('#signs li').forEach((li) => (li.hidden = !!q && !li.dataset.name.includes(q)));
  });

  const closeDetail = (detail) => {
    $('.player', detail)?.destroy();
    detail.innerHTML = '';
    detail.hidden = true;
    detail.parentElement.classList.remove('open');
  };

  $('#signs').addEventListener('click', (e) => {
    const row = e.target.closest('.sign-row');
    if (!row) return;
    const li = row.parentElement;
    const detail = $('.sign-detail', li);
    const wasOpen = !detail.hidden;
    $$('.sign-detail:not([hidden])').forEach(closeDetail);
    if (wasOpen) return;

    const sign = signById.get(Number(li.dataset.id));
    li.classList.add('open');
    detail.hidden = false;
    detail.append(createPlayer(sign.id));
    detail.insertAdjacentHTML('beforeend', `
      <form class="inline-form">
        <input name="name" value="${esc(sign.name)}" aria-label="Sign name" autocomplete="off">
        <button class="btn small">Save</button>
      </form>
      <button type="button" class="btn small danger" data-del>Delete sign</button>`);
    $('form', detail).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = ev.target.name.value.trim();
      if (!name || name === sign.name) return;
      await db.renameSign(sign.id, name);
      sign.name = name;
      $('.sign-name', li).textContent = name;
      li.dataset.name = name.toLowerCase();
      toast('Renamed');
    });
    $('[data-del]', detail).addEventListener('click', async () => {
      if (!confirm(`Delete “${sign.name}” and its video?`)) return;
      closeDetail(detail);
      await db.deleteSign(sign.id);
      signById.delete(sign.id);
      li.remove();
      $('#signsTitle').textContent = `Signs (${signById.size})`;
      toast('Sign deleted');
    });
  });

  $('#npd').addEventListener('change', async (e) => {
    const n = Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0)));
    e.target.value = n;
    deck.newPerDay = n;
    await db.put('decks', deck);
    toast('Saved');
  });

  $('#rename').addEventListener('click', async () => {
    const name = prompt('Deck name', deck.name)?.trim();
    if (!name || name === deck.name) return;
    const other = await db.findDeckByName(name);
    if (other && other.id !== deck.id) return toast('A deck with that name already exists');
    deck.name = name;
    await db.put('decks', deck);
    route();
  });

  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Delete “${deck.name}”, its ${plural(signs.length, 'video')} and all progress? This can't be undone.`)) return;
    await db.deleteDeck(deck.id);
    toast('Deck deleted');
    location.hash = '#/';
  });
}

async function viewImport(ctx, [deckId]) {
  const decks = (await db.getAll('decks')).sort(byName);
  if (!ctx.alive()) return;
  const preselect = decks.find((d) => d.id === Number(deckId));
  const items = []; // { file, name, checked, fresh }
  let busy = false;

  app.innerHTML = `
    ${header('Import videos', { back: preselect ? `#/deck/${preselect.id}` : '#/' })}
    <main class="page">
      <label class="field"><span>Deck</span>
        <select id="deck">
          ${decks.map((d) => `<option value="${d.id}" ${d === preselect ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          <option value="new" ${preselect ? '' : 'selected'}>+ New deck…</option>
        </select>
      </label>
      <label class="field" id="newWrap"><span>New deck name</span>
        <input id="newName" placeholder="e.g. Alphabet" autocomplete="off">
      </label>
      <input type="file" id="file" multiple accept="${ACCEPT}" hidden>
      <button type="button" class="btn block" id="pick">Choose videos…</button>
      <p class="hint">On iPhone, tap <b>Choose Files</b> (or <b>Browse</b>), open <b>Google Drive</b> or <b>Downloads</b>, tap <b>Select</b> and pick all videos of one collection.
        Avoid the Photo Library: it renames videos. You can pick more than once to add more files.</p>
      <div id="preview"></div>
    </main>`;

  const deckSel = $('#deck');
  const syncNewWrap = () => ($('#newWrap').hidden = deckSel.value !== 'new');
  syncNewWrap();

  let existing = new Set();
  async function loadExisting() {
    existing = deckSel.value === 'new'
      ? new Set()
      : new Set((await db.getAll('signs', 'deckId', Number(deckSel.value))).map((s) => s.name.toLowerCase()));
  }

  function computeDup() {
    const seen = new Set();
    for (const it of items) {
      const key = it.name.trim().toLowerCase();
      it.dup = existing.has(key) ? 'already in deck' : seen.has(key) ? 'duplicate' : '';
      if (it.checked) seen.add(key);
      if (it.fresh) { it.checked = !it.dup; it.fresh = false; if (it.checked) seen.add(key); }
    }
  }

  function updateFlags() {
    computeDup();
    $$('#preview li').forEach((li, i) => {
      const it = items[i];
      $('.tag', li).textContent = it.dup;
      $('input[type=checkbox]', li).checked = it.checked;
    });
    const n = items.filter((i) => i.checked && i.name.trim()).length;
    const go = $('#go');
    go.textContent = `Import ${plural(n, 'video')}`;
    go.disabled = !n || busy;
  }

  function renderPreview() {
    computeDup();
    const total = items.reduce((s, i) => s + i.file.size, 0);
    $('#preview').innerHTML = items.length ? `
      <h2>${plural(items.length, 'video')} <span class="muted">· ${bytes(total)}</span></h2>
      <p class="hint">Check the names: this is what you'll be quizzed on.</p>
      <ul class="list import-list">
        ${items.map((it, i) => `
          <li data-i="${i}">
            <input type="checkbox" ${it.checked ? 'checked' : ''} aria-label="Include">
            <div class="import-main">
              <input class="name" value="${esc(it.name)}" autocomplete="off" aria-label="Sign name">
              <span class="muted small">${esc(it.file.name)} · ${bytes(it.file.size)} <span class="tag"></span></span>
            </div>
          </li>`).join('')}
      </ul>
      <div class="progress" id="progress" hidden><progress max="${items.length}" value="0"></progress><span id="progressText"></span></div>
      <button type="button" class="btn primary block" id="go"></button>` : '';
    if (!items.length) return;
    $$('#preview li').forEach((li) => {
      const it = items[Number(li.dataset.i)];
      $('input[type=checkbox]', li).addEventListener('change', (e) => { it.checked = e.target.checked; updateFlags(); });
      $('input.name', li).addEventListener('input', (e) => { it.name = e.target.value; updateFlags(); });
    });
    $('#go').addEventListener('click', runImport);
    updateFlags();
  }

  deckSel.addEventListener('change', async () => {
    syncNewWrap();
    await loadExisting();
    for (const it of items) it.fresh = true;
    if (items.length) updateFlags();
  });

  $('#pick').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => {
    const known = new Set(items.map((i) => `${i.file.name}|${i.file.size}`));
    for (const file of e.target.files) {
      if (known.has(`${file.name}|${file.size}`)) continue;
      items.push({ file, name: parseSignName(file.name), checked: true, fresh: true });
    }
    items.sort((a, b) => naturalCompare(a.name, b.name));
    e.target.value = '';
    renderPreview();
  });

  async function runImport() {
    if (busy) return;
    let deck;
    if (deckSel.value === 'new') {
      const name = $('#newName').value.trim();
      if (!name) { toast('Enter a name for the new deck'); $('#newName').focus(); return; }
      deck = await db.findDeckByName(name);
      if (!deck) deck = await db.get('decks', await db.createDeck(name));
    } else {
      deck = await db.get('decks', Number(deckSel.value));
    }

    const selected = items.filter((i) => i.checked && i.name.trim());
    busy = true;
    $$('#preview input, #pick, #deck, #newName').forEach((el) => (el.disabled = true));
    $('#go').disabled = true;
    $('#progress').hidden = false;
    const bar = $('#progress progress');
    bar.max = selected.length;

    let ok = 0;
    const failed = [];
    let quotaHit = false;
    for (const [i, it] of selected.entries()) {
      $('#progressText').textContent = `Saving ${i + 1} of ${selected.length}…`;
      try {
        const data = await it.file.arrayBuffer();
        await db.addSign(deck, it.name.trim(), data, videoType(it.file));
        ok++;
      } catch (err) {
        console.error(err);
        failed.push(it.name);
        if (err?.name === 'QuotaExceededError') { quotaHit = true; break; }
      }
      bar.value = i + 1;
    }
    busy = false;
    await requestPersist();

    if (quotaHit) alert(`Your phone ran out of space for this app after ${ok} videos. Free up storage and import the rest.`);
    else if (failed.length) alert(`Imported ${ok}. These could not be read:\n${failed.join('\n')}`);
    else toast(`Imported ${plural(ok, 'video')}`);
    location.hash = `#/deck/${deck.id}`;
  }

  await loadExisting();
}

async function viewStudy(ctx, _args, params) {
  const all = await db.getAll('decks');
  const p = params.get('decks');
  const ids = !p || p === 'all' ? all.map((d) => d.id) : p.split(',').map(Number);
  const mode = params.get('mode') || ls.get('mode', 'both');
  const session = await Session.load(ids, mode);
  if (!ctx.alive()) return;
  const back = ids.length === 1 && p !== 'all' ? `#/deck/${ids[0]}` : '#/';

  app.innerHTML = `
    <div class="study">
      <header class="bar">
        <a class="icon-btn" href="${back}" aria-label="Close">${ICON.close}</a>
        <div id="counts"></div>
        <button type="button" class="icon-btn" id="undo" aria-label="Undo last answer" disabled>${ICON.undo}</button>
      </header>
      <main class="card-area" id="card"></main>
      <footer class="actions" id="actions"></footer>
    </div>`;

  let current = null;
  let revealed = false;
  let player = null;
  let timer = null;
  let busy = false;

  const updateCounts = () => {
    $('#counts').innerHTML = countsHtml(session.counts());
    $('#undo').disabled = !session.history.length;
  };

  function show(card) {
    clearTimeout(timer);
    player?.destroy();
    player = null;
    current = card;
    revealed = false;
    const sign = session.signs.get(card.signId);
    const deck = session.decks.get(card.deckId);
    $('#card').innerHTML = `
      ${session.decks.size > 1 ? `<div class="deck-tag">${esc(deck?.name)}</div>` : ''}
      <div class="prompt">${card.mode === 'video2word' ? 'What does this sign mean?' : 'How do you sign this?'}</div>
      <div class="slot-word"></div>
      <div class="slot-video"></div>`;
    if (card.mode === 'video2word') {
      player = createPlayer(card.signId);
      $('.slot-video').append(player);
    } else {
      $('.slot-word').innerHTML = `<div class="word">${esc(sign?.name)}</div>`;
    }
    $('#actions').innerHTML = '<button type="button" class="btn primary block big" id="reveal">Show answer</button>';
    $('#reveal').addEventListener('click', reveal);
    updateCounts();
  }

  function reveal() {
    if (!current || revealed) return;
    revealed = true;
    const sign = session.signs.get(current.signId);
    if (current.mode === 'video2word') {
      $('.slot-word').innerHTML = `<div class="word revealed">${esc(sign?.name)}</div>`;
    } else {
      player = createPlayer(current.signId);
      $('.slot-video').append(player);
    }
    const labels = session.preview(current);
    $('#actions').innerHTML = `<div class="ratings">
      ${['Again', 'Hard', 'Good', 'Easy'].map((l, i) => `<button type="button" class="rate r${i + 1}" data-r="${i + 1}"><span class="ivl">${labels[i]}</span>${l}</button>`).join('')}
    </div>`;
    $$('#actions [data-r]').forEach((b) => b.addEventListener('click', () => rate(Number(b.dataset.r))));
  }

  async function rate(r) {
    if (!revealed || busy || !current) return;
    busy = true;
    try { await session.answer(current, r); } finally { busy = false; }
    next();
  }

  function next() {
    const card = session.next();
    if (card) return show(card);
    current = null;
    player?.destroy();
    player = null;
    const due = session.nextLearningDue();
    $('#card').innerHTML = due
      ? `<div class="done"><div class="done-icon">⏳</div><h2>Nice work!</h2>
           <p>More cards in ${formatDuration(due - Date.now())}. Keep this screen open or come back later.</p></div>`
      : `<div class="done"><div class="done-icon">🎉</div><h2>${session.answered ? 'All done for today' : 'Nothing to study right now'}</h2>
           <p>${session.answered ? `You answered ${plural(session.answered, 'card')}.` : 'Come back tomorrow, or raise “New signs per day” in the deck settings.'}</p></div>`;
    $('#actions').innerHTML = `<a class="btn block" href="${back}">Back</a>`;
    updateCounts();
    if (due) timer = setTimeout(next, Math.max(1000, due - Date.now() + 500));
  }

  $('#undo').addEventListener('click', async () => {
    const card = await session.undo();
    if (card) show(card);
  });

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal(); else rate(3);
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
      rate(Number(e.key));
    } else if (e.key === 'z') {
      $('#undo').click();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => {
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
  });

  next();
}

async function viewSettings(ctx) {
  const [defNpd, pendingCount] = await Promise.all([db.getMeta('defaultNewPerDay', 10), db.count('pending')]);
  if (!ctx.alive()) return;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;

  app.innerHTML = `
    ${header('Settings', { back: '#/' })}
    <main class="page">
      <section>
        <h2>Storage</h2>
        <p id="usage" class="muted">Checking…</p>
        <p id="persist" class="muted"></p>
        <button type="button" class="btn block" id="persistBtn" hidden>Keep my data permanently</button>
      </section>

      <section>
        <h2>New decks</h2>
        <label class="field"><span>Default new signs per day</span>
          <input type="number" id="defNpd" inputmode="numeric" min="0" max="999" value="${defNpd}">
        </label>
      </section>

      <section>
        <h2>Backup progress</h2>
        <p class="hint">Saves your decks and learning progress (not the videos) to a small file. After reinstalling, import it here and re-import the videos: progress is matched by deck and sign name.</p>
        <button type="button" class="btn block" id="export">Export progress</button>
        <button type="button" class="btn block" id="importBtn">Import progress…</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
        ${pendingCount ? `<p class="hint">${plural(pendingCount, 'card')} of imported progress are waiting for their videos.</p>` : ''}
      </section>

      <section>
        <h2>Install on iPhone</h2>
        ${standalone ? '<p class="ok">✓ Running as a home screen app.</p>' : `
        <ol class="hint">
          <li>Open this page in <b>Safari</b>.</li>
          <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
          <li>Open Sign Cards from the home screen and import your videos <i>there</i>. The home screen app has its own storage, separate from Safari.</li>
        </ol>`}
        <p class="hint">Videos are stored only on this device. Deleting the home screen app deletes them too.</p>
      </section>

      <section>
        <h2>Danger zone</h2>
        <button type="button" class="btn danger block" id="wipe">Delete all data</button>
      </section>
    </main>`;

  (async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) $('#usage').textContent = `Using ${bytes(est.usage)}${est.quota ? ` of ${bytes(est.quota)} available` : ''}.`;
      else $('#usage').textContent = 'Storage information not available.';
      const persisted = await navigator.storage?.persisted?.();
      if (persisted !== undefined) {
        $('#persist').textContent = persisted ? '✓ Data is stored permanently.' : 'The browser may clear data if the phone runs low on space.';
        $('#persistBtn').hidden = persisted;
      }
    } catch {}
  })();

  $('#persistBtn').addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? 'Data will be kept' : 'The browser declined. Adding the app to the home screen usually helps.');
    if (ok) route();
  });

  $('#defNpd').addEventListener('change', async (e) => {
    const n = Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0)));
    e.target.value = n;
    await db.setMeta('defaultNewPerDay', n);
    toast('Saved');
  });

  $('#export').addEventListener('click', async () => shareOrDownload(await buildExport()));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { updated, waiting } = await importProgress(JSON.parse(await file.text()));
      alert(`Progress restored for ${plural(updated, 'card')}.${waiting ? `\n${plural(waiting, 'card')} will be restored when you import their videos.` : ''}`);
      route();
    } catch (err) {
      alert(`Could not import: ${err.message}`);
    }
  });

  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL decks, videos and progress from this device?')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;
    await db.deleteEverything();
    location.hash = '#/';
    location.reload();
  });
}

const VIEWS = { '': viewDecks, deck: viewDeck, import: viewImport, study: viewStudy, settings: viewSettings };

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker failed', err));
}
