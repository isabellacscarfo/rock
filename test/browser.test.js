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
  if (url.includes('/v1/playlists/')) {
    return json({ items: [
      { item: { uri: 'spotify:track:PL_CROSSROAD', id: 'PL_CROSSROAD', name: 'Cross Road Blues', artists: [{ name: 'Robert Johnson' }] } },
      { item: { uri: 'spotify:track:PL_CANAAN', id: 'PL_CANAAN', name: 'How Far Am I From Canaan?', artists: [{ name: 'Sam Cooke' }] } },
      { item: { uri: 'spotify:track:PL_BSS_PERKINS', id: 'PL_BSS_PERKINS', name: 'Blue Suede Shoes', artists: [{ name: 'Carl Perkins' }] } },
    ], next: null });
  }
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
  if (url.startsWith('https://api.github.com/repos/isabellacscarfo/rock/contents/content.json')) {
    const g = window.__gh;
    if (!g.text) g.text = await (await realFetch('content.json')).text();
    const enc = (t) => { let b = ''; new TextEncoder().encode(t).forEach((x) => { b += String.fromCharCode(x); }); return btoa(b); };
    if (!opt.method || opt.method === 'GET') return json({ content: enc(g.text), sha: 'sha' + g.v });
    const body = JSON.parse(opt.body);
    if (g.pipEditsDuringSave) {           // someone else commits between our read and our write
      g.pipEditsDuringSave = false;
      const d = JSON.parse(g.text); d.chapters[1].items[0].lyr = 'Pip changed this.'; g.text = JSON.stringify(d); g.v++;
    }
    if (body.sha !== 'sha' + g.v) return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
    g.text = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))); g.v++; g.commits.push(body.message);
    return json({});
  }
  return realFetch(url, opt);
};
window.__gh = { text: null, v: 1, commits: [], pipEditsDuringSave: false };
// Clip audio: "plays" for 50 ms
HTMLMediaElement.prototype.play = function () { __log.push('clip:' + this.src); setTimeout(() => this.onended && this.onended(), 50); return Promise.resolve(); };
HTMLMediaElement.prototype.pause = function () {};
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
    await page.route('https://itunes.apple.com/**', (r) => {
      const u = new URL(r.request().url()), term = u.searchParams.get('term');
      const body = { results: [{ trackName: term.split(' Scott')[0], artistName: 'Scott Joplin', previewUrl: 'https://clips.test/' + encodeURIComponent(term) + '.m4a' }] };
      r.fulfill({ contentType: 'text/javascript', body: `${u.searchParams.get('callback')}(${JSON.stringify(body)})` });
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#spstate').textContent === 'ready.');
    const log = () => page.evaluate(() => window.__log.slice());
    const status = () => page.textContent('#status');

    // Play from the top: Week 1, Jailhouse Rock (3 sentences), then its song (not in the playlist: from search)
    await page.click('#pp');
    await page.waitForFunction(() => __log.some((x) => x.startsWith('song:')));
    let l = await log();
    assert.deepEqual(l.filter((x) => x.startsWith('say:')).length, 3);
    assert.equal(l[l.length - 1], 'song:spotify:track:JailhouseRock');
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
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Blue Suede Shoes, by Elvis')));

    // Skip during talk goes to that song. Elvis's version, not the Carl Perkins one from the playlist.
    await page.click('#skip');
    await page.waitForFunction(() => __log[__log.length - 1] === 'song:spotify:track:BlueSuedeShoes');

    // Skip during the song goes to the next item
    await page.click('#skip');
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Tutti Frutti')));

    // Tapping a song in the list starts there; a song in the playlist uses the playlist's version
    await page.click('#list button.song:has-text("Cross Road Blues")');
    await page.click('#skip');
    await page.waitForFunction(() => __log[__log.length - 1] === 'song:spotify:track:PL_CROSSROAD');
    assert.match(await page.textContent('#now'), /Chapter 1: Cross Road Blues/);
    assert.equal(await page.getAttribute('#list button.song[aria-current]', 'data-c'), '1');

    // Artist alias: Soul Stirrers song matches the playlist's Sam Cooke entry
    await page.click('#list button.song:has-text("Canaan")');
    await page.click('#skip');
    await page.waitForFunction(() => __log[__log.length - 1] === 'song:spotify:track:PL_CANAAN');

    // A song Spotify can't find is skipped with a note, and the page doesn't scroll by itself
    await page.evaluate(() => { CHAPTERS[1].items.find((x) => x.s === 'Lost Your Head Blues').q = 'NOTFOUND'; });
    await page.click('#list button.song:has-text("Lost Your Head Blues")');
    const y = await page.evaluate(() => window.scrollY);
    await page.click('#skip');
    await page.waitForFunction(() => document.querySelector('#now').textContent.includes("Three O'Clock"));
    assert.match(await page.textContent('#note'), /Not found: Lost Your Head Blues/);
    assert.equal(await page.evaluate(() => window.scrollY), y);

    // Details are collapsed by default and show the narration and notes
    const d = page.locator('details').first();
    assert.equal(await d.evaluate((e) => e.open), false);
    await d.locator('summary').click();
    await d.locator('h3').first().waitFor();
    assert.match(await d.textContent(), /Jailhouse Rock, by Elvis Presley/);
    assert.match(await d.textContent(), /Notes/);

    // Without a GitHub token there's no Edit button, just a hint
    assert.equal(await d.locator('button:has-text("Edit")').count(), 0);
    assert.match(await d.textContent(), /add a GitHub token/);
    await page.fill('#editing input', 'tok');
    await page.click('#editing button:has-text("Save token")');
    await d.locator('summary').click(); await d.locator('summary').click();   // reopen to refresh
    await d.locator('h3').first().waitFor();

    // Edit and save: committed to GitHub, merged with a change someone else pushed meanwhile
    await page.evaluate(() => { __gh.pipEditsDuringSave = true; });
    await d.locator('button:has-text("Edit")').click();
    await d.locator('textarea').first().fill('First new line.\nSecond new line.');
    await d.locator('button:has-text("Save")').click();
    await d.locator('p:has-text("First new line.")').waitFor();
    const saved = await page.evaluate(() => JSON.parse(__gh.text));
    assert.deepEqual(saved.chapters[0].items[0].n, ['First new line.', 'Second new line.']);
    assert.equal(saved.chapters[1].items[0].lyr, 'Pip changed this.');
    assert.deepEqual(await page.evaluate(() => __gh.commits), ['Edit narration/notes: Jailhouse Rock']);

    // The new narration is what gets read aloud
    await page.click('#list button.song:has-text("Jailhouse Rock")');
    await page.waitForFunction(() => __log[__log.length - 1] === 'say:First new line.');
    await page.click('#pp');

    // Chapter buttons start that chapter from its first song
    await page.click('#chapters button:has-text("3")');
    await page.waitForFunction(() => __log[__log.length - 1].startsWith('say:How Far Am I from Canaan'));
    assert.match(await page.textContent('#now'), /Chapter 3: How Far Am I from Canaan/);

    // Long narration: used when the song has one, short narration otherwise
    await page.evaluate(() => { CHAPTERS[2].items.find((x) => x.s === "Three O'Clock Blues").nl = ['A long first sentence.', 'A long second sentence.']; });
    await page.click('#narration');
    assert.equal(await page.textContent('#narration'), 'Narration: long');
    await page.click('#chapters button:has-text("2")');
    await page.waitForFunction(() => __log[__log.length - 1] === 'say:A long first sentence.');
    assert.match(await status(), /of 2\)/);
    await page.click('#skip'); await page.click('#skip');          // song, then the next item (no long text)
    await page.waitForFunction(() => __log[__log.length - 1].startsWith('say:Hoochie Coochie Man'));
    await page.click('#narration');
    assert.equal(await page.textContent('#narration'), 'Narration: short');
    await page.click('#pp');

    // Extra songs: hidden by default; when on, they appear in book order and play a 30-second clip
    assert.equal(await page.locator('#list button.song:has-text("Maple Leaf Rag")').count(), 0);
    await page.click('#extras');
    assert.equal(await page.textContent('#extras'), 'Extra songs: on');
    await page.click('#list button.song:has-text("Before rock and roll")');   // narration-only stop, then the next stop
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Chapter one: Roots of Rock Music')));
    await page.click('#skip');                                                 // skip the rest of that talk
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Ragtime was mainly')));
    await page.click('#skip');                                                 // to its clip
    await page.waitForFunction(() => __log.some((x) => x.startsWith('clip:https://clips.test/Maple')));
    await page.waitForFunction(() => __log.some((x) => x.startsWith('say:Tin Pan Alley')));   // clip ended, next stop
    await page.click('#pp');
    await page.click('#extras');
    assert.equal(await page.locator('#list button.song:has-text("Maple Leaf Rag")').count(), 0);

    // Spotify status is at the bottom of the page
    assert.equal(await page.evaluate(() => document.querySelector('#list').nextElementSibling.id), 'spotify');
    assert.equal(await page.evaluate(() => document.querySelector('#spotify').nextElementSibling.id), 'editing');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); server.close();
  }
});
