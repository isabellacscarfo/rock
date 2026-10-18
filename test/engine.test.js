// Behavior tests for engine.js. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../engine.js');

const CH = [
  { title: 'C1', items: [
    { a: 'A1', s: 'S1', n: ['one', 'two'] },
    { a: 'A2', s: 'S2', n: ['three'] },
  ] },
  { title: 'C2', items: [
    { a: 'A3', s: 'S3', n: ['four'] },
  ] },
];

// Fakes that record calls and let the test decide when speech/songs finish.
function rig(opts = {}) {
  const log = [];
  let speechDone = null, songDone = null;
  const speak = (t) => { log.push('say:' + t); return new Promise(r => { speechDone = r; }); };
  const stopSpeech = () => { if (speechDone) { const r = speechDone; speechDone = null; r(); } };
  const music = {
    play: (it) => { log.push('song:' + it.s); return new Promise(r => { songDone = r; }); },
    pause: () => log.push('music.pause'),
    resume: () => log.push('music.resume'),
    stop: () => { if (songDone) { const r = songDone; songDone = null; r('stopped'); } },
  };
  const e = createEngine({ chapters: opts.chapters || CH, speak, stopSpeech, music });
  const tick = () => new Promise(r => setImmediate(r));
  return {
    e, log, tick,
    async endSpeech() { const r = speechDone; speechDone = null; r(); await tick(); },
    async endSong(res = 'ended') { const r = songDone; songDone = null; r(res); await tick(); },
    pos() { const s = e.state(); return `${s.status} ${s.c}.${s.i} ${s.phase}${s.phase === 'talk' ? ':' + s.line : ''}`; },
  };
}

test('plays talk sentences, then the song, then the next item', async () => {
  const r = rig();
  r.e.play(); await r.tick();
  assert.equal(r.pos(), 'playing 0.0 talk:0');
  await r.endSpeech(); await r.endSpeech();
  assert.equal(r.pos(), 'playing 0.0 song');
  await r.endSong();
  assert.equal(r.pos(), 'playing 0.1 talk:0');
  assert.deepEqual(r.log, ['say:one', 'say:two', 'song:S1', 'say:three']);
});

test('continues into the next chapter and goes idle at the very end', async () => {
  const r = rig();
  r.e.goto(0, 1); await r.tick();
  await r.endSpeech(); await r.endSong();
  assert.equal(r.pos(), 'playing 1.0 talk:0');
  await r.endSpeech(); await r.endSong();
  assert.equal(r.pos(), 'idle 0.0 talk:0');
  assert.equal(r.e.state().note, 'Finished.');
});

test('pause during talk, then play, repeats the current sentence', async () => {
  const r = rig();
  r.e.play(); await r.tick(); await r.endSpeech();     // now on 'two'
  r.e.pause(); await r.tick();
  assert.equal(r.pos(), 'paused 0.0 talk:1');
  r.e.play(); await r.tick();
  assert.deepEqual(r.log, ['say:one', 'say:two', 'say:two']);
  assert.equal(r.pos(), 'playing 0.0 talk:1');
});

test('pause during song, then play, resumes the same song (no restart)', async () => {
  const r = rig();
  r.e.play(); await r.tick(); await r.endSpeech(); await r.endSpeech();
  r.e.pause(); r.e.play(); await r.tick();
  assert.deepEqual(r.log.slice(-3), ['song:S1', 'music.pause', 'music.resume']);
  await r.endSong();
  assert.equal(r.pos(), 'playing 0.1 talk:0');
});

test('skip during talk jumps to this item\'s song', async () => {
  const r = rig();
  r.e.play(); await r.tick();
  r.e.skip(); await r.tick();
  assert.equal(r.pos(), 'playing 0.0 song');
  assert.deepEqual(r.log, ['say:one', 'song:S1']);
});

test('skip during song jumps to the next item\'s talk', async () => {
  const r = rig();
  r.e.play(); await r.tick(); r.e.skip(); await r.tick();
  r.e.skip(); await r.tick();
  assert.equal(r.pos(), 'playing 0.1 talk:0');
  assert.deepEqual(r.log, ['say:one', 'song:S1', 'say:three']);
});

test('skip pressed many times in a row always lands on a clean position', async () => {
  const r = rig();
  r.e.play(); await r.tick();
  for (let k = 0; k < 3; k++) r.e.skip();               // talk->song->next talk->song
  await r.tick();
  assert.equal(r.pos(), 'playing 0.1 song');
  assert.deepEqual(r.log.filter(x => x.startsWith('song')), ['song:S2']);
});

test('skip while paused moves but stays paused, and play starts from there', async () => {
  const r = rig();
  r.e.play(); await r.tick(); r.e.pause();
  r.e.skip(); await r.tick();
  assert.equal(r.pos(), 'paused 0.0 song');
  r.e.play(); await r.tick();
  assert.deepEqual(r.log, ['say:one', 'song:S1']);
});

test('pause in a song, skip, then play does not resume the old song', async () => {
  const r = rig();
  r.e.play(); await r.tick(); r.e.skip(); await r.tick();
  r.e.pause(); r.e.skip(); await r.tick();
  r.e.play(); await r.tick();
  assert.deepEqual(r.log, ['say:one', 'song:S1', 'music.pause', 'say:three']);
});

test('prev goes to the start of the previous item, across chapters', async () => {
  const r = rig();
  r.e.goto(1, 0); await r.tick();
  r.e.prev(); await r.tick();
  assert.equal(r.pos(), 'playing 0.1 talk:0');
  r.e.prev(); r.e.prev(); await r.tick();
  assert.equal(r.pos(), 'playing 0.0 talk:0');
});

test('a song that is not on Spotify is skipped with a note', async () => {
  const r = rig();
  r.e.play(); await r.tick(); r.e.skip(); await r.tick();
  await r.endSong('notfound');
  assert.equal(r.pos(), 'playing 0.1 talk:0');
  assert.match(r.e.state().note, /Not found on Spotify: S1/);
});

test('goto while a song plays stops it and starts the chosen item', async () => {
  const r = rig();
  r.e.play(); await r.tick(); r.e.skip(); await r.tick();
  r.e.goto(1, 0); await r.tick();
  assert.equal(r.pos(), 'playing 1.0 talk:0');
  assert.deepEqual(r.log, ['say:one', 'song:S1', 'say:four']);
});

test('a stale speech ending after pause does not move the position', async () => {
  const r = rig();
  r.e.play(); await r.tick();
  r.e.pause(); await r.tick(); await r.tick();
  assert.equal(r.pos(), 'paused 0.0 talk:0');
});
