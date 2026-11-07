import * as db from './db.js';
import { Session, deckProgress } from './study.js';
import { ACCEPT, parseSignName, videoType, naturalCompare, isVideoEntry, deckNameFromZip } from './importer.js';
import { readZip, ZipError } from './zip.js';
import { buildExport, shareOrDownload, importProgress } from './backup.js';

const app = document.getElementById('app');
// Answer buttons → rating (see progress.js for the weights).
const RATINGS = [[1, 'À revoir'], [2, 'Difficile'], [3, 'Je sais']];
const MODES = { both: 'Les deux', video2word: 'Signe → Mot', word2video: 'Mot → Signe' };

// ---------- small helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const byName = (a, b) => naturalCompare(a.name, b.name);
// French: 0 and 1 are singular.
const plural = (n, word, many = `${word}s`) => `${n} ${Math.abs(n) < 2 ? word : many}`;

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function bytes(n) {
  const dec = (x, d) => x.toFixed(d).replace('.', ',');
  if (!n) return '0 Mo';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} Ko`;
  if (n < 1e9) return `${dec(n / 1e6, 1)} Mo`;
  return `${dec(n / 1e9, 2)} Go`;
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

function header(title, { back, left, right } = {}) {
  return `<header class="bar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Retour">${ICON.back}</a>` : left || '<span class="icon-btn"></span>'}
    <h1>${esc(title)}</h1>
    ${right || '<span class="icon-btn"></span>'}
  </header>`;
}

function knownHtml({ known, total }) {
  const pct = total ? Math.round((known / total) * 100) : 0;
  return `<span class="known"><b>${known}/${total}</b> ${known < 2 ? 'connu' : 'connus'}</span>
    <span class="known-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>`;
}

function modePicker() {
  const cur = ls.get('mode', 'both');
  return `<div class="segmented" role="radiogroup" aria-label="Mode d'étude">
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
  wrap.innerHTML = `<div class="video-box"><video playsinline webkit-playsinline muted loop autoplay preload="auto"></video></div>
    <div class="player-controls">
      <button type="button" class="chip" data-act="replay">↺ Rejouer</button>
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
    speedBtn.textContent = `Vitesse ${String(r).replace('.', ',')}×`;
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
      video.parentElement.replaceWith(Object.assign(document.createElement('div'), { className: 'no-video', textContent: 'Vidéo introuvable' }));
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
    if (ctx.alive()) app.innerHTML = `${header('Oups', { back: '#/' })}<main class="page"><p class="error">Une erreur s'est produite : ${esc(err.message)}</p></main>`;
  }
}

// ---------- views ----------

async function viewDecks(ctx) {
  const decks = (await db.getAll('decks')).sort(byName);
  const rows = await Promise.all(decks.map(async (d) => ({ d, p: await deckProgress(d.id) })));
  if (!ctx.alive()) return;

  app.innerHTML = `
    ${header('Flashcards', {
      left: rows.length > 1 ? '<button type="button" class="text-btn" id="selLeft">Sélectionner</button>' : undefined,
      right: `<span class="bar-right"><button type="button" class="text-btn" id="selDone" hidden>OK</button><a class="icon-btn" id="gear" href="#/settings" aria-label="Réglages">${ICON.gear}</a></span>`,
    })}
    <main class="page" id="home">
      ${rows.length ? `
        <ul class="list">
          ${rows.map(({ d, p }) => `
            <li class="deck-item" data-id="${d.id}">
              <span class="deck-check" role="checkbox" aria-checked="false" aria-label="Sélectionner ${esc(d.name)}"></span>
              <a class="deck-main" href="#/deck/${d.id}">
                <span class="deck-name">${esc(d.name)}</span>
                ${knownHtml(p)}
              </a>
              <a class="btn small primary deck-study" href="#/study?decks=${d.id}">Étudier</a>
            </li>`).join('')}
        </ul>
        ${modePicker()}
        ${rows.length > 1 ? '<a class="btn primary block" id="studyBtn" href="#/study?decks=all">Étudier tous les decks</a>' : ''}
      ` : `
        <div class="empty">
          <div class="empty-icon">🤟</div>
          <h2>Aucun deck pour l'instant</h2>
          <p>Importez une collection de vidéos de signes. Le nom de chaque fichier vidéo devient le nom du signe.</p>
        </div>`}
      <a class="btn block" id="importBtn" href="#/import">${ICON.plus} Importer des vidéos</a>
    </main>`;
  bindModePicker();
  if (rows.length > 1) bindDeckSelection(rows.map(({ d }) => d.id));
}

/** iPhone-style selection: "Sélectionner" shows checkboxes and turns the study button into "Étudier la sélection". */
function bindDeckSelection(ids) {
  const home = $('#home');
  const selected = new Set();
  let selecting = false;

  const sync = () => {
    home.classList.toggle('selecting', selecting);
    $('#selLeft').textContent = !selecting ? 'Sélectionner' : selected.size === ids.length ? 'Aucun' : 'Tout';
    $('#selDone').hidden = !selecting;
    $('#gear').hidden = selecting;
    $('#importBtn').hidden = selecting;
    $$('.deck-item').forEach((li) => {
      const on = selected.has(Number(li.dataset.id));
      li.classList.toggle('checked', on);
      $('.deck-check', li).setAttribute('aria-checked', on);
    });
    const btn = $('#studyBtn');
    const n = selected.size;
    if (!selecting) {
      btn.textContent = 'Étudier tous les decks';
      btn.href = '#/study?decks=all';
    } else {
      btn.textContent = n ? `Étudier la sélection (${n})` : 'Étudier la sélection';
      btn.href = n ? `#/study?decks=${ids.filter((id) => selected.has(id)).join(',')}` : '#/';
    }
    btn.classList.toggle('disabled', selecting && !n);
  };

  $('#selLeft').addEventListener('click', () => {
    if (!selecting) selecting = true;
    else if (selected.size === ids.length) selected.clear();
    else ids.forEach((id) => selected.add(id));
    sync();
  });
  $('#selDone').addEventListener('click', () => {
    selecting = false;
    selected.clear();
    sync();
  });
  // While selecting, tapping a deck row checks it instead of opening the deck.
  $$('.deck-item').forEach((li) => li.addEventListener('click', (e) => {
    if (!selecting) return;
    e.preventDefault();
    const id = Number(li.dataset.id);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    sync();
  }));
  sync();
}

async function viewDeck(ctx, [id]) {
  const deck = await db.get('decks', Number(id));
  if (!deck) return location.replace('#/');
  const [signs, progress] = await Promise.all([db.getAll('signs', 'deckId', deck.id), deckProgress(deck.id)]);
  if (!ctx.alive()) return;
  signs.sort(byName);
  const signById = new Map(signs.map((s) => [s.id, s]));

  app.innerHTML = `
    ${header(deck.name, { back: '#/' })}
    <main class="page">
      <div class="stat-row">${knownHtml(progress)}</div>
      ${modePicker()}
      <a class="btn primary block" href="#/study?decks=${deck.id}">Étudier</a>
      <a class="btn block" href="#/import/${deck.id}">${ICON.plus} Ajouter des vidéos</a>

      <h2 id="signsTitle">Signes (${signs.length})</h2>
      <input type="search" id="search" placeholder="Rechercher un signe" autocomplete="off">
      <ul class="list sign-list" id="signs">
        ${signs.map((s) => `
          <li data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}">
            <button type="button" class="sign-row"><span class="sign-name">${esc(s.name)}</span>${ICON.chevron}</button>
            <div class="sign-detail" hidden></div>
          </li>`).join('')}
      </ul>

      <h2>Deck</h2>
      <button type="button" class="btn block" id="rename">Renommer le deck</button>
      <button type="button" class="btn danger block" id="delete">Supprimer le deck</button>
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
        <input name="name" value="${esc(sign.name)}" aria-label="Nom du signe" autocomplete="off">
        <button class="btn small">Enregistrer</button>
      </form>
      <button type="button" class="btn small danger" data-del>Supprimer le signe</button>`);
    $('form', detail).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = ev.target.name.value.trim();
      if (!name || name === sign.name) return;
      await db.renameSign(sign.id, name);
      sign.name = name;
      $('.sign-name', li).textContent = name;
      li.dataset.name = name.toLowerCase();
      toast('Renommé');
    });
    $('[data-del]', detail).addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${sign.name} » et sa vidéo ?`)) return;
      closeDetail(detail);
      await db.deleteSign(sign.id);
      signById.delete(sign.id);
      li.remove();
      $('#signsTitle').textContent = `Signes (${signById.size})`;
      toast('Signe supprimé');
    });
  });

  $('#rename').addEventListener('click', async () => {
    const name = prompt('Nom du deck', deck.name)?.trim();
    if (!name || name === deck.name) return;
    const other = await db.findDeckByName(name);
    if (other && other.id !== deck.id) return toast('Un deck porte déjà ce nom');
    deck.name = name;
    await db.put('decks', deck);
    route();
  });

  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Supprimer « ${deck.name} », ${signs.length < 2 ? 'sa vidéo' : `ses ${signs.length} vidéos`} et toute la progression ? Cette action est irréversible.`)) return;
    await db.deleteDeck(deck.id);
    toast('Deck supprimé');
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
    ${header('Importer des vidéos', { back: preselect ? `#/deck/${preselect.id}` : '#/' })}
    <main class="page">
      <label class="field"><span>Deck</span>
        <select id="deck">
          ${decks.map((d) => `<option value="${d.id}" ${d === preselect ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          <option value="new" ${preselect ? '' : 'selected'}>+ Nouveau deck…</option>
        </select>
      </label>
      <label class="field" id="newWrap"><span>Nom du nouveau deck</span>
        <input id="newName" placeholder="ex. Alphabet" autocomplete="off">
      </label>
      <input type="file" id="file" multiple accept="${ACCEPT}" hidden>
      <input type="file" id="zipFile" accept=".zip,application/zip" hidden>
      <button type="button" class="btn block" id="pick">Choisir des vidéos…</button>
      <button type="button" class="btn block" id="pickZip">Importer une collection (.zip)…</button>
      <p class="hint">Sur iPhone, touchez <b>Choisir des fichiers</b> (ou <b>Parcourir</b>), ouvrez <b>Google Drive</b> ou <b>Téléchargements</b>, touchez <b>Sélectionner</b> et choisissez toutes les vidéos d'une collection.
        Évitez la Photothèque : elle renomme les vidéos. Vous pouvez choisir plusieurs fois pour ajouter d'autres fichiers.</p>
      <p class="hint">Ou choisissez le <b>.zip</b> d'une collection : le deck prend le nom du fichier zip.</p>
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
      it.dup = existing.has(key) ? 'déjà dans le deck' : seen.has(key) ? 'doublon' : '';
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
    go.textContent = `Importer ${plural(n, 'vidéo')}`;
    go.disabled = !n || busy;
  }

  function renderPreview() {
    computeDup();
    const total = items.reduce((s, i) => s + i.file.size, 0);
    $('#preview').innerHTML = items.length ? `
      <h2>${plural(items.length, 'vidéo')} <span class="muted">· ${bytes(total)}</span></h2>
      <p class="hint">Vérifiez les noms : c'est sur eux que vous serez interrogé.</p>
      <ul class="list import-list">
        ${items.map((it, i) => `
          <li data-i="${i}">
            <input type="checkbox" ${it.checked ? 'checked' : ''} aria-label="Inclure">
            <div class="import-main">
              <input class="name" value="${esc(it.name)}" autocomplete="off" aria-label="Nom du signe">
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

  $('#pickZip').addEventListener('click', () => $('#zipFile').click());
  $('#zipFile').addEventListener('change', async (e) => {
    const zip = e.target.files[0];
    e.target.value = '';
    if (!zip || busy) return;
    let entries;
    try {
      entries = await readZip(zip);
    } catch (err) {
      console.error(err);
      return alert(`Impossible d'ouvrir « ${zip.name} ». ${err instanceof ZipError ? err.message : 'Est-ce un fichier zip valide ?'}`);
    }
    const videos = entries.filter((en) => isVideoEntry(en.path));
    if (!videos.length) return alert(`« ${zip.name} » ne contient aucune vidéo (.mp4, .mov, .m4v, .webm, .3gp).`);
    const locked = videos.filter((v) => v.encrypted).length;
    if (locked) toast(`${plural(locked, 'vidéo ignorée', 'vidéos ignorées')} : protégées par mot de passe`);

    // The collection takes the zip's name: reuse that deck if it exists, else create it.
    const deckName = deckNameFromZip(zip.name);
    const match = decks.find((d) => d.name.toLowerCase() === deckName.toLowerCase());
    deckSel.value = match ? String(match.id) : 'new';
    $('#newName').value = match ? '' : deckName;
    syncNewWrap();
    await loadExisting();

    items.length = 0; // a zip is one collection, so it replaces any earlier picks
    for (const file of videos) {
      if (file.encrypted) continue;
      items.push({ file, name: parseSignName(file.name), checked: true, fresh: true });
    }
    items.sort((a, b) => naturalCompare(a.name, b.name));
    renderPreview();
    toast(match ? `Ajout au deck existant « ${match.name} »` : `Nouveau deck « ${deckName} »`);
  });

  async function runImport() {
    if (busy) return;
    let deck;
    if (deckSel.value === 'new') {
      const name = $('#newName').value.trim();
      if (!name) { toast('Saisissez un nom pour le nouveau deck'); $('#newName').focus(); return; }
      deck = await db.findDeckByName(name);
      if (!deck) deck = await db.get('decks', await db.createDeck(name));
    } else {
      deck = await db.get('decks', Number(deckSel.value));
    }

    const selected = items.filter((i) => i.checked && i.name.trim());
    busy = true;
    $$('#preview input, #pick, #pickZip, #deck, #newName').forEach((el) => (el.disabled = true));
    $('#go').disabled = true;
    $('#progress').hidden = false;
    const bar = $('#progress progress');
    bar.max = selected.length;

    let ok = 0;
    const failed = [];
    let quotaHit = false;
    for (const [i, it] of selected.entries()) {
      $('#progressText').textContent = `Enregistrement ${i + 1} sur ${selected.length}…`;
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

    if (quotaHit) alert(`Votre téléphone n'a plus assez d'espace pour l'app après ${plural(ok, 'vidéo')}. Libérez de l'espace et importez le reste.`);
    else if (failed.length) alert(`${plural(ok, 'vidéo importée', 'vidéos importées')}. Ces fichiers n'ont pas pu être lus :\n${failed.join('\n')}`);
    else toast(plural(ok, 'vidéo importée', 'vidéos importées'));
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

  document.documentElement.classList.add('no-scroll');
  cleanups.push(() => document.documentElement.classList.remove('no-scroll'));
  app.innerHTML = `
    <div class="study">
      <header class="bar">
        <a class="icon-btn" href="${back}" aria-label="Fermer">${ICON.close}</a>
        <div id="counts"></div>
        <button type="button" class="icon-btn" id="undo" aria-label="Annuler la dernière réponse" disabled>${ICON.undo}</button>
      </header>
      <main class="card-area" id="card"></main>
      <footer class="actions" id="actions"></footer>
    </div>`;

  let current = null;
  let revealed = false;
  let player = null;
  let busy = false;

  const updateCounts = () => {
    const left = session.remaining();
    $('#counts').innerHTML = `<span class="left">${left} ${left < 2 ? 'restante' : 'restantes'}</span>`;
    $('#undo').disabled = !session.history.length;
  };

  function show(card) {
    player?.destroy();
    player = null;
    current = card;
    revealed = false;
    const sign = session.signs.get(card.signId);
    const deck = session.decks.get(card.deckId);
    $('#card').innerHTML = `
      ${session.decks.size > 1 ? `<div class="deck-tag">${esc(deck?.name)}</div>` : ''}
      <div class="prompt">${card.mode === 'video2word' ? 'Que signifie ce signe ?' : 'Comment signe-t-on ceci ?'}</div>
      <div class="slot-word"></div>
      <div class="slot-video"></div>`;
    if (card.mode === 'video2word') {
      player = createPlayer(card.signId);
      $('.slot-video').append(player);
    } else {
      $('.slot-word').innerHTML = `<div class="word">${esc(sign?.name)}</div>`;
    }
    $('#actions').innerHTML = '<button type="button" class="btn primary block big" id="reveal">Voir la réponse</button>';
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
    $('#actions').innerHTML = `<div class="ratings">
      ${RATINGS.map(([r, l]) => `<button type="button" class="rate r${r}" data-r="${r}">${l}</button>`).join('')}
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
    $('#card').innerHTML = session.queue.length
      ? `<div class="done"><div class="done-icon">🎉</div><h2>Session terminée</h2>
           <p>Vous avez révisé ${plural(session.answered, 'signe')}. Les signes ratés ont plus de chances de revenir à la prochaine session.</p></div>`
      : `<div class="done"><div class="done-icon">🤟</div><h2>Aucun signe à étudier</h2>
           <p>Importez des vidéos pour commencer.</p></div>`;
    $('#actions').innerHTML = `<div class="ratings two">
      <a class="btn" href="${back}">Retour</a>
      ${session.queue.length ? '<button type="button" class="btn primary" id="again">Nouvelle session</button>' : ''}
    </div>`;
    $('#again')?.addEventListener('click', () => route());
    updateCounts();
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
    } else if (revealed && ['1', '2', '3'].includes(e.key)) {
      rate(Number(e.key));
    } else if (e.key === 'z') {
      $('#undo').click();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  next();
}

async function viewSettings(ctx) {
  const [sessionSize, pendingCount] = await Promise.all([db.getSessionSize(), db.count('pending')]);
  if (!ctx.alive()) return;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;

  app.innerHTML = `
    ${header('Réglages', { back: '#/' })}
    <main class="page">
      <section>
        <h2>Stockage</h2>
        <p id="usage" class="muted">Vérification…</p>
        <p id="persist" class="muted"></p>
        <button type="button" class="btn block" id="persistBtn" hidden>Conserver mes données durablement</button>
      </section>

      <section>
        <h2>Étude</h2>
        <label class="field"><span>Signes par session</span>
          <input type="number" id="sessionSize" inputmode="numeric" min="1" max="999" value="${sessionSize}">
        </label>
        <p class="hint">Au début de chaque session, les signes sont tirés au hasard et chacun n'apparaît qu'une fois.
          Plus un signe est difficile, plus il a de chances d'être tiré :
          <b>À revoir</b> ×4, <b>Difficile</b> ×3, nouveau ou <b>Je sais</b> ×2, connu ×1
          (connu = <b>Je sais</b> plus de 5 fois de suite).</p>
      </section>

      <section>
        <h2>Sauvegarde de la progression</h2>
        <p class="hint">Enregistre vos decks et votre progression (pas les vidéos) dans un petit fichier. Après une réinstallation, importez-le ici puis réimportez les vidéos : la progression est retrouvée grâce aux noms des decks et des signes.</p>
        <button type="button" class="btn block" id="export">Exporter la progression</button>
        <button type="button" class="btn block" id="importBtn">Importer une progression…</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
        ${pendingCount ? `<p class="hint">La progression importée de ${plural(pendingCount, 'signe')} attend ses vidéos.</p>` : ''}
      </section>

      <section>
        <h2>Installer sur iPhone</h2>
        ${standalone ? '<p class="ok">✓ L\'app est lancée depuis l\'écran d\'accueil.</p>' : `
        <ol class="hint">
          <li>Ouvrez cette page dans <b>Safari</b>.</li>
          <li>Touchez le bouton <b>Partager</b>, puis <b>Sur l'écran d'accueil</b>.</li>
          <li>Ouvrez Flashcards depuis l'écran d'accueil et importez vos vidéos <i>depuis l'app</i>. Elle a son propre stockage, séparé de Safari.</li>
        </ol>`}
        <p class="hint">Les vidéos sont stockées uniquement sur cet appareil. Supprimer l'app de l'écran d'accueil les supprime aussi.</p>
      </section>

      <section>
        <h2>Zone de danger</h2>
        <button type="button" class="btn danger block" id="wipe">Supprimer toutes les données</button>
      </section>
    </main>`;

  (async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) $('#usage').textContent = `${bytes(est.usage)} utilisés${est.quota ? ` sur ${bytes(est.quota)} disponibles` : ''}.`;
      else $('#usage').textContent = 'Informations de stockage indisponibles.';
      const persisted = await navigator.storage?.persisted?.();
      if (persisted !== undefined) {
        $('#persist').textContent = persisted ? '✓ Les données sont conservées durablement.' : 'Le navigateur peut effacer les données si le téléphone manque d\'espace.';
        $('#persistBtn').hidden = persisted;
      }
    } catch {}
  })();

  $('#persistBtn').addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? 'Les données seront conservées' : 'Le navigateur a refusé. Ajouter l\'app à l\'écran d\'accueil aide généralement.');
    if (ok) route();
  });

  $('#sessionSize').addEventListener('change', async (e) => {
    const n = Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1)));
    e.target.value = n;
    await db.setSessionSize(n);
    toast('Enregistré');
  });

  $('#export').addEventListener('click', async () => shareOrDownload(await buildExport()));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { updated, waiting } = await importProgress(JSON.parse(await file.text()));
      alert(`Progression restaurée pour ${plural(updated, 'signe')}.${waiting ? `\n${plural(waiting, 'signe')} : restauration à l'import des vidéos.` : ''}`);
      route();
    } catch (err) {
      alert(`Import impossible : ${err.message}`);
    }
  });

  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Supprimer TOUS les decks, vidéos et la progression de cet appareil ?')) return;
    if (!confirm('Vraiment ? Cette action est irréversible.')) return;
    await db.deleteEverything();
    location.hash = '#/';
    location.reload();
  });
}

const VIEWS = { '': viewDecks, deck: viewDeck, import: viewImport, study: viewStudy, settings: viewSettings };

window.addEventListener('hashchange', route);
db.migrateProgress().catch((err) => console.error(err)).finally(route);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker failed', err));
}
