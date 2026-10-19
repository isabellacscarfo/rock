// Browser glue: content loading and saving, Spotify login + in-page Spotify player, speech, and the UI.
// Behavior lives in engine.js. Content (chapters, narration, notes) lives in content.json.
const $ = (s) => document.querySelector(s);
const REPO = 'isabellacscarfo/rock', CONTENT_PATH = 'content.json', BRANCH = 'main';
let CHAPTERS = [], PLAYLIST_ID = '', engine = null;
let VIEW = [];   // CHAPTERS as shown and played: extra items (x) only when the Extra songs toggle is on
const store = {
  get(k, d) { try { const v = localStorage.getItem('rsp.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rsp.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- Spotify login (PKCE, no server needed) ---------- */
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state playlist-read-private';
const REDIRECT = location.origin + location.pathname;
const sp = { cid: store.get('cid', ''), tok: store.get('tok', null), error: '', playlistNote: '' };

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  store.set('ver', verifier);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: sp.cid, scope: SCOPES, redirect_uri: REDIRECT,
    code_challenge_method: 'S256', code_challenge: challenge });
}
async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Spotify login failed');
  sp.tok = { access: d.access_token, refresh: d.refresh_token || (sp.tok && sp.tok.refresh), exp: Date.now() + (d.expires_in - 60) * 1000 };
  store.set('tok', sp.tok);
}
async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.get('code') && !q.get('error')) return;
  history.replaceState(null, '', REDIRECT);
  if (q.get('error')) { sp.error = 'Spotify login was cancelled.'; return; }
  try { await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, client_id: sp.cid, code_verifier: store.get('ver', '') }); }
  catch (e) { sp.error = e.message; }
}
async function accessToken() {
  if (Date.now() > sp.tok.exp) await tokenRequest({ grant_type: 'refresh_token', refresh_token: sp.tok.refresh, client_id: sp.cid });
  return sp.tok.access;
}
async function api(path, opt = {}) {
  const r = await fetch('https://api.spotify.com/v1' + path, { ...opt,
    headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' } });
  if (r.status === 204 || r.status === 202) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Spotify error ' + r.status);
  return d;
}
function logout() { sp.tok = null; store.set('tok', null); if (player) player.disconnect(); player = null; deviceId = null; renderSpotify(); }

/* ---------- In-page Spotify player (Web Playback SDK) ---------- */
let player = null, deviceId = null;
function startPlayer() {
  if (player || !sp.tok) return;
  if (!window.Spotify) {
    window.onSpotifyWebPlaybackSDKReady = startPlayer;
    if (!document.getElementById('spSdk')) {
      const s = document.createElement('script'); s.id = 'spSdk'; s.src = 'https://sdk.scdn.co/spotify-player.js'; document.head.appendChild(s);
    }
    return;
  }
  player = new Spotify.Player({ name: 'Rock Styles Playlist', volume: 1, getOAuthToken: (cb) => accessToken().then(cb, () => cb('')) });
  player.addListener('ready', ({ device_id }) => { deviceId = device_id; sp.error = ''; renderSpotify(); });
  player.addListener('not_ready', () => { deviceId = null; renderSpotify(); });
  for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'])
    player.addListener(ev, ({ message }) => { sp.error = ev.replace('_', ' ') + ': ' + message; renderSpotify(); });
  player.connect();
}
// Phones only allow sound after a tap: call this inside every tap that can start playback.
function unlockAudio() { try { if (player) player.activateElement(); } catch (e) {} }

// Normalized title/artist for matching: lowercase, no "(...)", no " - Remastered"-style suffix, no articles.
const norm = (s) => (s || '').toLowerCase().replace(/&/g, 'and').replace(/\s+-\s+.*$/, '').replace(/\(.*?\)/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
const artistMatcher = (it) => {
  const words = norm([it.a, it.pa].filter(Boolean).join(' ')).split(' ').filter((w) => w.length > 2);
  return (t) => t.artists.some((x) => words.some((w) => norm(x.name).includes(w)));
};
const titleMatcher = (it) => {
  const title = norm(it.s);
  return (t) => { const n = norm(t.name); return n === title || n.startsWith(title) || (title.length > 4 && n.includes(title)); };
};

// The playlist's tracks, loaded once. If it can't be read, songs come from search only.
let playlistTracks = null;
function loadPlaylist() {
  if (!playlistTracks) playlistTracks = (async () => {
    const out = [];
    try {
      for (let url = `/playlists/${PLAYLIST_ID}/items?limit=50`; url; ) {
        const d = await api(url);
        for (const e of d.items || []) { const t = e.item || e.track; if (t && t.uri && t.artists) out.push(t); }
        url = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
      }
      sp.playlistNote = `${out.length} songs in your playlist.`;
    } catch (e) { sp.playlistNote = `Playlist not readable (${e.message}), using search.`; }
    renderSpotify();
    return out;
  })();
  return playlistTracks;
}

const trackCache = {};
function findTrack(it) {
  const key = it.a + '|' + it.s + '|' + (it.q || '');
  if (!trackCache[key]) trackCache[key] = (async () => {
    const artistOk = artistMatcher(it), titleOk = titleMatcher(it);
    const both = (t) => artistOk(t) && titleOk(t);
    const fromList = (await loadPlaylist()).find(both);
    if (fromList) return fromList.uri;
    const search = async (q) => ((await api('/search?type=track&limit=10&q=' + encodeURIComponent(q))).tracks || {}).items || [];
    if (it.q) { const t = (await search(it.q)).find(artistOk); return t && t.uri; }
    const t = (await search(`track:${it.s} artist:${it.a}`)).find(both) || (await search(`${it.a} ${it.s}`)).find(both);
    return t && t.uri;
  })();
  return trackCache[key];
}

// Music adapter for the engine. play() resolves when the song ends: 'ended' | 'notfound' | 'error' | 'stopped'.
const spotifyMusic = (() => {
  let cur = null; // { resolve, uri, started, userPaused, timer, t0 }
  const settle = (res) => { if (!cur) return; const c = cur; cur = null; clearInterval(c.timer); c.resolve(res); };
  const waitDevice = async (c) => { for (let k = 0; k < 30 && !deviceId && cur === c; k++) await new Promise((r) => setTimeout(r, 500)); return deviceId; };
  async function check(c) {
    let s = null; try { s = await player.getCurrentState(); } catch (e) {}
    if (cur !== c) return;
    const t = s && s.track_window.current_track;
    const ours = t && (t.uri === c.uri || (t.linked_from && t.linked_from.uri === c.uri) || t.id === c.id);
    if (!c.started) {
      if (ours && !s.paused) { c.started = true; c.id = t.id; }
      else if (Date.now() - c.t0 > 20000) { sp.error = 'Spotify did not start the song.'; renderSpotify(); settle('error'); }
      return;
    }
    if (!s || !ours) { player.pause().catch(() => {}); settle('ended'); return; }              // moved on to something else
    if (s.paused && !c.userPaused && (s.position === 0 || s.duration - s.position < 3000)) settle('ended');
  }
  return {
    play(it) {
      return new Promise((resolve) => {
        const c = { resolve, started: false, userPaused: false, timer: null };
        cur = c;
        (async () => {
          if (!sp.tok) { sp.error = 'Not logged in to Spotify.'; renderSpotify(); return settle('error'); }
          startPlayer();
          if (!await waitDevice(c)) { if (cur === c) { sp.error = sp.error || 'The Spotify player did not start.'; renderSpotify(); settle('error'); } return; }
          const uri = it.uri || await findTrack(it);
          if (cur !== c) return;
          if (!uri) return settle('notfound');
          c.uri = uri;
          await api('/me/player/play?device_id=' + deviceId, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
          if (cur !== c) { player.pause().catch(() => {}); return; }
          c.t0 = Date.now();
          c.timer = setInterval(() => check(c), 1000);
        })().catch((e) => { if (cur === c) { sp.error = e.message; renderSpotify(); settle('error'); } });
      });
    },
    pause() { if (cur) cur.userPaused = true; if (player) player.pause().catch(() => {}); },
    resume() { if (cur) cur.userPaused = false; if (player) player.resume().catch(() => {}); },
    stop() { const had = cur && cur.uri; settle('stopped'); if (had && player) player.pause().catch(() => {}); },
  };
})();

/* ---------- 30-second clips for extra songs (iTunes previews, no login needed) ---------- */
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'jsonp' + Math.random().toString(36).slice(2), s = document.createElement('script');
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); reject(new Error('timeout')); }, 8000);
    window[cb] = (d) => { done(); resolve(d); };
    s.onerror = () => { done(); reject(new Error('network')); };
    s.src = url + '&callback=' + cb; document.head.appendChild(s);
  });
}
const clipCache = {};
function findClip(it) {
  const key = (it.a || '') + '|' + it.s;
  if (!clipCache[key]) clipCache[key] = (async () => {
    const d = await jsonp('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + encodeURIComponent([it.s, it.a].filter(Boolean).join(' ')));
    const titleOk = titleMatcher(it), artistOk = artistMatcher(it);
    const toTrack = (x) => ({ name: x.trackName, artists: [{ name: x.artistName }], url: x.previewUrl });
    const tracks = (d.results || []).filter((x) => x.previewUrl).map(toTrack);
    const t = tracks.find((x) => titleOk(x) && artistOk(x)) || tracks.find(titleOk);
    return t && t.url;
  })().catch(() => { delete clipCache[key]; return null; });
  return clipCache[key];
}
const clipMusic = (() => {
  const audio = new Audio();
  let cur = null;
  const settle = (res) => { if (!cur) return; const c = cur; cur = null; audio.onended = audio.onerror = null; c(res); };
  return {
    play(it) {
      return new Promise((resolve) => {
        cur = resolve; const me = resolve;
        findClip(it).then((url) => {
          if (cur !== me) return;
          if (!url) return settle('notfound');
          audio.src = url; audio.onended = () => settle('ended'); audio.onerror = () => settle('error');
          audio.play().catch(() => settle('error'));
        });
      });
    },
    pause() { audio.pause(); },
    resume() { audio.play().catch(() => {}); },
    stop() { audio.pause(); settle('stopped'); },
  };
})();
// What the engine uses. Main songs (no x) play in full on Spotify. Extra songs (x) play in full when
// marked full (they are in the class playlist), otherwise a 30-second clip. Both flags are set in content.json.
const music = (() => {
  let active = spotifyMusic;
  return {
    play(it) { active = !it.x || it.full ? spotifyMusic : clipMusic; return active.play(it); },
    pause() { active.pause(); },
    resume() { active.resume(); },
    stop() { spotifyMusic.stop(); clipMusic.stop(); },
  };
})();

/* ---------- Speech (the phone's default text-to-speech voice) ---------- */
let speechDone = null, utterance = null;
function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { setTimeout(resolve, 500); return; }
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(to); if (speechDone === fin) speechDone = null; resolve(); };
    const to = setTimeout(fin, 5000 + text.length * 120);   // in case the phone never reports the end
    utterance = new SpeechSynthesisUtterance(text);           // kept in a variable: Chrome drops events of collected utterances
    utterance.lang = 'en-US'; utterance.onend = fin; utterance.onerror = fin;
    speechDone = fin;
    speechSynthesis.speak(utterance);
  });
}
function stopSpeech() { try { speechSynthesis.cancel(); } catch (e) {} if (speechDone) speechDone(); }

/* ---------- Keep the screen on while playing ---------- */
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (engine && document.visibilityState === 'visible' && engine.state().status === 'playing') keepAwake(true); });

/* ---------- Content: loaded from the site, saved by committing content.json to GitHub ---------- */
// Format of content.json: { playlist: Spotify playlist id, chapters: [{ title, sub, items: [item] }] }
// Item: a = artist, s = song, h = style and year, n = narration sentences (read before the song),
// x = extra item (shown only with Extra songs on; no s = narration only), full = extra song in the class
// playlist (plays in full; other extras play a 30-second clip),
// nl = long narration sentences (used in Long mode; falls back to n when empty),
// lyr = notes, pa = other artist name Spotify uses, q = Spotify search text, uri = exact track URI (all optional).
async function loadContent() {
  const r = await fetch(CONTENT_PATH, { cache: 'no-store' });
  if (!r.ok) throw new Error('Could not load ' + CONTENT_PATH);
  const d = await r.json();
  CHAPTERS = d.chapters; PLAYLIST_ID = d.playlist;
}

const gh = { token: store.get('ghToken', '') };
const toB64 = (text) => { let bin = ''; new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (ch) => ch.charCodeAt(0)));
async function ghApi(path, opt = {}) {
  const r = await fetch('https://api.github.com' + path, { ...opt, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || 'GitHub error ' + r.status); e.status = r.status; throw e; }
  return d;
}
// Change one song's narration and notes in the latest content.json on GitHub. Re-reads the file before
// writing, so other edits (from Pip or another device) are kept; retries if the file changed in between.
async function saveItem(chapterTitle, item, fields) {
  const same = (x) => x.a === item.a && x.s === item.s && x.h === item.h;
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await ghApi(`/repos/${REPO}/contents/${CONTENT_PATH}?ref=${BRANCH}`);
    const latest = JSON.parse(fromB64(file.content));
    const ch = latest.chapters.find((x) => x.title === chapterTitle);
    const it = ch && ch.items.find(same);
    if (!it) throw new Error('This song was renamed or moved on GitHub. Reload the page and try again.');
    Object.assign(it, fields);
    if (!it.nl || !it.nl.length) delete it.nl;
    try {
      await ghApi(`/repos/${REPO}/contents/${CONTENT_PATH}`, { method: 'PUT', body: JSON.stringify({
        message: `Edit narration/notes: ${item.s || item.h}`, branch: BRANCH, sha: file.sha,
        content: toB64(JSON.stringify(latest, null, 1) + '\n') }) });
      return;
    } catch (e) { if (e.status !== 409) throw e; }   // 409: someone saved in between, try again on the new version
  }
  throw new Error('The file kept changing while saving. Try again.');
}

/* ---------- Short / long narration ---------- */
let narration = store.get('narration', 'short');
const linesOf = (it) => (narration === 'long' && it.nl && it.nl.length ? it.nl : it.n);

/* ---------- UI ---------- */
function render(s) {
  s = s || engine.state();
  const it = VIEW[s.c].items[s.i];
  $('#pp').textContent = s.status === 'playing' ? 'Pause' : 'Play';
  $('#now').textContent = `${VIEW[s.c].title}: ${it.s ? it.s + (it.a ? ', ' + it.a : '') : it.h}`;
  $('#status').textContent =
    s.status === 'idle' ? (s.note || 'Stopped.') :
    s.status === 'paused' ? 'Paused.' :
    s.phase === 'talk' ? `Talking (${Math.min(s.line + 1, linesOf(it).length)} of ${linesOf(it).length})` : it.x && !it.full ? 'Clip playing' : 'Song playing';
  $('#narration').textContent = narration === 'long' ? 'Narration: long' : 'Narration: short';
  $('#extras').textContent = showExtras ? 'Extra songs: on' : 'Extra songs: off';
  $('#note').textContent = s.status === 'idle' ? '' : s.note;
  document.querySelectorAll('#list button.song').forEach((b) => {
    const here = +b.dataset.c === s.c && +b.dataset.i === s.i;
    if (here) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  keepAwake(s.status === 'playing');
}

function renderList() {
  const list = $('#list'); list.textContent = '';
  VIEW.forEach((ch, c) => {
    const h = document.createElement('h2'); h.textContent = `${ch.title}: ${ch.sub}`; list.appendChild(h);
    ch.items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'song'; b.dataset.c = c; b.dataset.i = i; b.textContent = itemLabel(it);
      b.onclick = () => { unlockAudio(); engine.goto(c, i); };
      const d = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = 'Details';
      const body = document.createElement('div');
      d.append(sum, body);
      d.addEventListener('toggle', () => { if (d.open) showDetails(body, c, i); });
      list.append(b, d);
    });
  });
}

const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
const btn = (text, onclick) => { const b = el('button', text); b.onclick = onclick; return b; };

function showDetails(body, c, i) {
  const it = VIEW[c].items[i];
  body.textContent = '';
  const section = (title, lines) => {
    body.append(el('h3', title));
    if (lines && lines.length) lines.forEach((line) => body.append(el('p', line))); else body.append(el('p', '(none)'));
  };
  section('Short narration', it.n);
  section('Long narration', it.nl);
  body.append(el('h3', 'Notes'), el('p', it.lyr || '(none)'));
  body.append(gh.token ? btn('Edit', () => editDetails(body, c, i)) : el('p', 'To edit, add a GitHub token at the bottom of the page.'));
}

function editDetails(body, c, i) {
  const it = VIEW[c].items[i];
  const n = el('textarea'); n.rows = 6; n.value = it.n.join('\n');
  const nl = el('textarea'); nl.rows = 10; nl.value = (it.nl || []).join('\n');
  const notes = el('textarea'); notes.rows = 6; notes.value = it.lyr || '';
  const msg = el('p');
  const saveBtn = btn('Save', async () => {
    const toLines = (t) => t.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const fields = { n: toLines(n), nl: toLines(nl), lyr: notes.value.trim() };
    saveBtn.disabled = true; msg.textContent = 'Saving...';
    try {
      await saveItem(VIEW[c].title, it, fields);
      Object.assign(it, fields);
      showDetails(body, c, i);
    } catch (e) { msg.textContent = 'Not saved: ' + e.message; saveBtn.disabled = false; }
  });
  body.textContent = '';
  body.append(el('h3', 'Short narration (one sentence per line)'), n, el('h3', 'Long narration (one sentence per line)'), nl,
    el('h3', 'Notes'), notes, msg,
    saveBtn, btn('Cancel', () => showDetails(body, c, i)));
}

function renderEditing() {
  const box = $('#editing');
  box.textContent = '';
  if (gh.token) {
    box.append(el('p', 'Editing: on. Saves go to GitHub.'), btn('Remove GitHub token', () => { gh.token = ''; store.set('ghToken', ''); renderEditing(); }));
    return;
  }
  const input = el('input'); input.placeholder = 'GitHub token'; input.autocomplete = 'off';
  box.append(el('p', 'Editing: off. To edit narration and notes, paste a GitHub token that can write to this repo.'), input,
    btn('Save token', () => { gh.token = input.value.trim(); store.set('ghToken', gh.token); renderEditing(); }));
}

function renderSpotify() {
  const box = $('#spotify');
  if (!sp.tok) {
    box.innerHTML = `<p>Spotify is not connected. Songs need Spotify Premium.</p>
      <p>One-time setup: at developer.spotify.com/dashboard, create an app, tick "Web API" and "Web Playback SDK",
      add this Redirect URI exactly: <code></code>, then paste the app's Client ID here.</p>
      <input id="cid" placeholder="Client ID" autocomplete="off"> <button id="login">Log in to Spotify</button>
      <p id="sperr"></p>`;
    box.querySelector('code').textContent = REDIRECT;
    $('#cid').value = sp.cid;
    $('#sperr').textContent = sp.error;
    $('#login').onclick = () => { sp.cid = $('#cid').value.trim(); store.set('cid', sp.cid); if (sp.cid) login(); };
    return;
  }
  box.innerHTML = `<p>Spotify: <span id="spstate"></span> <span id="spnote"></span> <button id="logout">Log out</button></p>`;
  $('#spstate').textContent = sp.error ? 'problem: ' + sp.error : deviceId ? 'ready.' : 'connecting...';
  $('#spnote').textContent = sp.playlistNote;
  $('#logout').onclick = logout;
}

function renderChapterButtons() {
  const box = $('#chapters'); box.textContent = '';
  VIEW.forEach((ch, c) => box.append(btn(ch.title.replace(/^Chapter /, ''), () => { unlockAudio(); engine.goto(c, 0); })));
}
// Extra songs toggle: rebuild what is shown and played (stops playback; positions change)
let showExtras = store.get('extras', false);
const itemLabel = (it) => it.s ? `${it.s}${it.a ? ', ' + it.a : ''} (${it.h})${it.x ? ', extra' : ''}` : it.h;
function buildView() {
  if (engine) engine.pause();
  stopSpeech(); music.stop();
  VIEW = CHAPTERS.map((ch) => ({ ...ch, items: ch.items.filter((it) => showExtras || !it.x) })).filter((ch) => ch.items.length);
  const e = createEngine({ chapters: VIEW, speak, stopSpeech, music, lines: linesOf, onChange: (st) => { if (engine === e) render(st); } });
  engine = e;
  renderChapterButtons(); renderList(); render();
}
$('#extras').onclick = () => { showExtras = !showExtras; store.set('extras', showExtras); if (CHAPTERS.length) buildView(); };
$('#narration').onclick = () => { narration = narration === 'long' ? 'short' : 'long'; store.set('narration', narration); if (engine) render(); };
$('#pp').onclick = () => { if (!engine) return; unlockAudio(); engine.toggle(); };
$('#skip').onclick = () => { if (!engine) return; unlockAudio(); engine.skip(); };
$('#prev').onclick = () => { if (!engine) return; unlockAudio(); engine.prev(); };

(async () => {
  renderSpotify(); renderEditing();
  try { await loadContent(); } catch (e) { $('#status').textContent = e.message; return; }
  buildView();
  await handleRedirect();
  renderSpotify(); startPlayer(); if (sp.tok) loadPlaylist();
})();
