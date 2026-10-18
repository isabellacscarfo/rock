// Browser glue: Spotify login + in-page Spotify player, speech, and the UI. Behavior lives in engine.js.
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rsp.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rsp.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- Spotify login (PKCE, no server needed) ---------- */
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
const REDIRECT = location.origin + location.pathname;
const sp = { cid: store.get('cid', ''), tok: store.get('tok', null), error: '' };

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

const norm = (s) => (s || '').toLowerCase().replace(/&/g, 'and').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
const trackCache = {};
function findTrack(it) {
  const key = it.a + '|' + it.s;
  if (!trackCache[key]) trackCache[key] = (async () => {
    const artistWords = norm(it.a).split(' ').filter((w) => w.length > 2);
    const artistOk = (t) => t.artists.some((x) => artistWords.some((w) => norm(x.name).includes(w)));
    const title = norm(it.s);
    const titleOk = (t) => { const n = norm(t.name); return n === title || n.startsWith(title) || (title.length > 4 && n.includes(title)); };
    const search = async (q) => ((await api('/search?type=track&limit=10&q=' + encodeURIComponent(q))).tracks || {}).items || [];
    if (it.q) { const t = (await search(it.q)).find(artistOk); return t && t.uri; }
    let t = (await search(`track:${it.s} artist:${it.a}`)).find((x) => artistOk(x) && titleOk(x));
    if (!t) t = (await search(`${it.a} ${it.s}`)).find((x) => artistOk(x) && titleOk(x));
    return t && t.uri;
  })();
  return trackCache[key];
}

// Music adapter for the engine. play() resolves when the song ends: 'ended' | 'notfound' | 'error' | 'stopped'.
const music = (() => {
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && engine.state().status === 'playing') keepAwake(true); });

/* ---------- UI ---------- */
const engine = createEngine({ chapters: CHAPTERS, speak, stopSpeech, music, onChange: render });

function render(s) {
  s = s || engine.state();
  const it = CHAPTERS[s.c].items[s.i];
  $('#pp').textContent = s.status === 'playing' ? 'Pause' : 'Play';
  $('#now').textContent = `${CHAPTERS[s.c].title}: ${it.s}, ${it.a}`;
  $('#status').textContent =
    s.status === 'idle' ? (s.note || 'Stopped.') :
    s.status === 'paused' ? 'Paused.' :
    s.phase === 'talk' ? `Talking (${Math.min(s.line + 1, it.n.length)} of ${it.n.length})` : 'Song playing';
  $('#note').textContent = s.status === 'idle' ? '' : s.note;
  document.querySelectorAll('#list button').forEach((b) => {
    const here = +b.dataset.c === s.c && +b.dataset.i === s.i;
    if (here) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  keepAwake(s.status === 'playing');
}

function renderList() {
  const list = $('#list'); list.textContent = '';
  CHAPTERS.forEach((ch, c) => {
    const h = document.createElement('h2'); h.textContent = `${ch.title}: ${ch.sub}`; list.appendChild(h);
    ch.items.forEach((it, i) => {
      const b = document.createElement('button');
      b.dataset.c = c; b.dataset.i = i; b.textContent = `${it.s}, ${it.a} (${it.h})`;
      b.onclick = () => { unlockAudio(); engine.goto(c, i); };
      list.appendChild(b);
    });
  });
}

function renderSpotify() {
  const el = $('#spotify');
  if (!sp.tok) {
    el.innerHTML = `<p>Spotify is not connected. Songs need Spotify Premium.</p>
      <p>One-time setup: at developer.spotify.com/dashboard, create an app, tick "Web API" and "Web Playback SDK",
      add this Redirect URI exactly: <code></code>, then paste the app's Client ID here.</p>
      <input id="cid" placeholder="Client ID" autocomplete="off"> <button id="login">Log in to Spotify</button>
      <p id="sperr"></p>`;
    el.querySelector('code').textContent = REDIRECT;
    $('#cid').value = sp.cid;
    $('#sperr').textContent = sp.error;
    $('#login').onclick = () => { sp.cid = $('#cid').value.trim(); store.set('cid', sp.cid); if (sp.cid) login(); };
    return;
  }
  el.innerHTML = `<p>Spotify: <span id="spstate"></span> <button id="logout">Log out</button></p>`;
  $('#spstate').textContent = sp.error ? 'problem: ' + sp.error : deviceId ? 'ready.' : 'connecting...';
  $('#logout').onclick = logout;
}

$('#pp').onclick = () => { unlockAudio(); engine.toggle(); };
$('#skip').onclick = () => { unlockAudio(); engine.skip(); };
$('#prev').onclick = () => { unlockAudio(); engine.prev(); };

renderList(); render(); renderSpotify();
handleRedirect().then(() => { renderSpotify(); startPlayer(); });
