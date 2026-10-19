// Playback state machine. No browser code here, so it can be tested with fakes (see test/engine.test.js).
//
// Position: chapter c, item i, phase 'talk' (reading sentence `line` of item.n) or 'song'.
// Status:   'idle' (nothing started / finished), 'playing', 'paused'.
//
// Rules (the whole behavior of the player):
//   play     idle/paused -> playing. Paused in a song resumes the song where it was.
//            Paused in the talk restarts the current sentence.
//   pause    playing -> paused. Position is kept.
//   skip     talk -> this item's song. song -> next item's talk. Keeps playing/paused as it was.
//   prev     -> start of the previous item (or of this item if it's the first). Keeps playing/paused.
//   goto     -> start of chapter c item i, and plays.
//   After a song ends (or can't be played) the next item starts. After the last item: idle.
//   An item without a song (s) is narration only: after its talk, the next item starts.
//
// Adapters:
//   speak(text) -> Promise, resolves when done or cancelled.   stopSpeech() cancels it.
//   music.play(item) -> Promise<'ended'|'notfound'|'error'|'stopped'>
//   music.pause(), music.resume(), music.stop()  (stop makes the pending play() resolve 'stopped')
//   lines(item) -> the sentences to read for an item (optional, default item.n)

function createEngine({ chapters, speak, stopSpeech, music, onChange, lines = (it) => it.n }) {
  const st = { status: 'idle', c: 0, i: 0, phase: 'talk', line: 0, note: '' };
  let gen = 0;           // bumped whenever the running loop must stop
  let songLive = false;  // a song is loaded in the player (so resume can continue it)

  const snapshot = () => ({ ...st });
  const emit = () => { if (onChange) onChange(snapshot()); };
  const item = () => chapters[st.c].items[st.i];

  function toStart(c, i) { st.c = c; st.i = i; st.phase = 'talk'; st.line = 0; }
  function nextItem() {
    if (st.i + 1 < chapters[st.c].items.length) toStart(st.c, st.i + 1);
    else if (st.c + 1 < chapters.length) toStart(st.c + 1, 0);
    else return false;
    return true;
  }
  function halt() { gen++; songLive = false; stopSpeech(); music.stop(); }
  function finish() { toStart(0, 0); st.status = 'idle'; st.note = 'Finished.'; emit(); }

  async function loop(g) {
    while (g === gen && st.status === 'playing') {
      const it = item();
      if (st.phase === 'talk') {
        if (st.line < lines(it).length) {
          emit();
          await speak(lines(it)[st.line]);
          if (g !== gen) return;
          st.line++;
        } else {
          st.phase = 'song';
        }
        continue;
      }
      if (!it.s) { if (!nextItem()) { gen++; finish(); return; } continue; }   // narration-only stop
      songLive = true; st.note = ''; emit();
      const r = await music.play(it);
      if (g !== gen) return;
      songLive = false;
      if (r === 'notfound') st.note = `Not found: ${it.s}. Skipped.`;
      else if (r === 'error') st.note = `Couldn't play ${it.s}. Skipped.`;
      if (!nextItem()) { gen++; finish(); return; }
    }
  }
  // Start on the next tick, so several taps in a row only start the last position.
  function run() { const g = ++gen; st.status = 'playing'; emit(); Promise.resolve().then(() => loop(g)); }

  return {
    state: snapshot,
    play() {
      if (st.status === 'playing') return;
      if (st.status === 'paused' && st.phase === 'song' && songLive) { st.status = 'playing'; music.resume(); emit(); return; }
      if (st.status === 'idle') st.note = '';
      run();
    },
    pause() {
      if (st.status !== 'playing') return;
      st.status = 'paused';
      if (st.phase === 'song' && songLive) music.pause();
      else { gen++; stopSpeech(); }
      emit();
    },
    toggle() { st.status === 'playing' ? this.pause() : this.play(); },
    skip() {
      const was = st.status;
      halt();
      if (st.phase === 'talk') { st.phase = 'song'; st.line = lines(item()).length; }
      else if (!nextItem()) { finish(); return; }
      if (was === 'playing') run(); else { if (was === 'idle') st.status = 'paused'; emit(); }
    },
    prev() {
      const was = st.status;
      halt();
      if (st.i > 0) toStart(st.c, st.i - 1);
      else if (st.c > 0) toStart(st.c - 1, chapters[st.c - 1].items.length - 1);
      else toStart(0, 0);
      if (was === 'playing') run(); else { if (was === 'idle') st.status = 'paused'; emit(); }
    },
    goto(c, i) { halt(); toStart(c, i); st.note = ''; run(); },
  };
}

if (typeof module !== 'undefined') module.exports = { createEngine };
