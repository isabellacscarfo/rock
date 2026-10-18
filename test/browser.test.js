// End-to-end test of the real page in headless Chromium, with Spotify and speech faked.
// Run: node --test test/   (skipped automatically if Playwright isn't installed)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {}

const FAKES = `
window.__log = [];
localStorage.setItem('rsp.tok', JSON.stringify({ access: 'x', refresh: 'y', exp: Date.now() + 1e8 }));
// Speech: each sentence "lasts" 40 ms
Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  _t: null,
  speak(u) { __log.push('say:' + u.text); this._u = u; this._t = setTimeout(() => u.onend && u.onend(), 40); },
  cancel() { clearTimeout(this._t); if (this._u && this._u.onend) { const u = this._u; this._u = null; u.onend(); } },
} });
Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: function (t) { this.text = t; } });
// Spotify Web API
const realFetch = window.fetch;
window.fetch = async (url, opt = {}) => {
  url = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/v1/search')) {
    const q = decodeURIComponent(url.split('q=')[1]);
    const m = q.match(/track:(.*) artist:(.*)/);
    const [song, artist] = m ? [m[1], m[2]] : [q, q];
    if (/Suspicious|NOTFOUND/.test(q)) return json({ tracks: { items: [] } });
    return json({ tracks: { items: [{ uri: 'spotify:track:' + song.replace(/\\W/g, ''), id: song.replace(/\\W/g, ''), name: song, artists: [{ name: artist }] }] } });
  }
  if (url.includes('/v1/me/player/play')) {
    const uri = JSON.parse(opt.body).uris[0];
    __log.push('song:' + uri);
    window.__pl.state = { paused: false, position: 1000, duration: 200000, track_window: { current_track: { uri, id: uri.split(':')[2] } } };
    return new Response(null, { status: 204 });
  }
  return realFetch(url, opt);
};
`;
const FAKE_SDK = `
window.Spotify = { Player: class {
  constructor(o) { this.l = {}; this.state = null; window.__pl = this; }
  addListener(e, f) { this.l[e] = f; }
  connect() { setTimeout(() => this.l.ready({ device_id: 'dev1' }), 30); return Promise.resolve(true); }
  activateElement() {}
  getCurrentState() { return Promise.resolve(this.state); }
  pause() { if (this.state) this.state.paused = true; __log.push('pause'); return Promise.resolve(); }
  resume() { if (this.state) this.state.paused = false; __log.push('resume'); return Promise.resolve(); }
  disconnect() {}
} };
window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady();
`;

test('real page: talk, song, end of song, skip, pause/resume', { skip: !chromium && 'playwright not installed' }, async () => {
  const root = path.join(__dirname, '..');
  const server = http.createServer((req, res) => {
    const f = path.join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(f, (err, data) => { res.writeHead(err ? 404 : 200); res.end(data); });
  }).listen(0);
  const port = server.address().port;
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(FAKES);
    await page.route('https://sdk.scdn.co/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#spstate').textContent === 'ready.');
    const log = () => page.evaluate(() => window.__log.slice());
    const status = () => page.textContent('#status');

    // Play: reads the 4 sentences of item 1, then plays its song
    await page.click('#pp');
    await page.waitForFunction(() => __log.some((x) => x.startsWith('song:')));
    let l = await log();
    assert.equal(l.filter((x) => x.startsWith('say:')).length, 4);
    assert.equal(l[l.length - 1], 'song:spotify:track:CrossRoadBlues');
    assert.equal(await status(), 'Song playing');
    assert.equal(await page.textContent('#pp'), 'Pause');

    // Pause during the song pauses Spotify; Play resumes it (no new song request)
    await page.click('#pp');
    assert.equal(await status(), 'Paused.');
    await page.click('#pp');
    l = await log();
    assert.deepEqual(l.slice(-2), ['pause', 'resume']);
    assert.equal(l.filter((x) => x.startsWith('song:')).length, 1);

    // The song ends (Spotify reports paused at position 0): the next item's talk starts
    await page.evaluate(() => { __pl.state.paused = true; __pl.state.position = 0; });
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Lost Your Head')));
    assert.match(await page.textContent('#now'), /Lost Your Head Blues/);

    // Skip during talk goes straight to that item's song
    await page.click('#skip');
    await page.waitForFunction(() => __log[__log.length - 1] === 'song:spotify:track:LostYourHeadBlues');

    // Skip during the song goes to the next item (chapter 2)
    await page.click('#skip');
    await page.waitForFunction(() => __log.some((x) => x.startsWith("say:Three O'Clock Blues")));
    assert.match(await page.textContent('#now'), /Chapter 2: Three O'Clock Blues/);

    // Tapping an item in the list starts there; the current item is marked
    await page.click('#list button:has-text("Later Elvis")');
    const y = await page.evaluate(() => window.scrollY);
    await page.click('#skip');                       // jump to its song: not on (fake) Spotify -> skipped with a note
    await page.waitForFunction(() => document.querySelector('#now').textContent.includes('Tutti Frutti'));
    assert.match(await page.textContent('#note'), /Not found on Spotify: Later Elvis/);
    assert.equal(await page.getAttribute('#list button[aria-current]', 'data-i'), await page.evaluate(() => {
      const it = CHAPTERS[3].items.findIndex((x) => x.s === 'Tutti Frutti'); return String(it); }));

    // The page didn't scroll by itself when it moved on to the next item
    assert.equal(await page.evaluate(() => window.scrollY), y);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); server.close();
  }
});
