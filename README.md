# Rock Styles Playlist

Hands-free listening tour for a rock music class. Press Play once: for each song it reads a short
narration with the phone's text-to-speech voice, then plays the full song with Spotify inside the
page (Spotify Web Playback SDK, Premium needed), then moves on.

Hosted as a static site from this repo (GitHub Pages). No build step.

## Files
- `index.html`: markup and minimal CSS.
- `content.json`: the chapters, songs, narration and notes (format documented at the top of the
  content section in `app.js`). Songs are matched to the Spotify playlist `playlist` first
  (title + artist), then found by Spotify search.
- `engine.js`: the playback state machine. The full behavior rules are in the comment at the top.
- `app.js`: browser glue (Spotify login + player, speech, wake lock, UI).
- `test/engine.test.js`: behavior tests for the state machine.
- `test/browser.test.js`: end-to-end test of the real page in headless Chromium with Spotify and speech faked.
- `archive/narration.js`: old recorded narration, not loaded.

## Editing text
`content.json` is the single source of truth. It is edited two ways, both as commits to `main`:
- In the page: Details > Edit > Save (needs a GitHub fine-grained token with Contents read/write on
  this repo, pasted once at the bottom of the page). Save re-reads the latest file and changes only that
  song, so other edits are never overwritten.
- By an agent: pull first, edit `content.json`, run the tests, push.
Hosted on GitHub Pages from `main` (root). `.nojekyll` disables Jekyll processing.

## Tests
`npm install && npm test`. Set `CHROMIUM_PATH` to use an existing Chromium binary.
Any behavior change should come with a test.

## Spotify setup (once)
developer.spotify.com/dashboard: create an app with "Web API" and "Web Playback SDK", add the page's
exact URL as a Redirect URI, then paste the Client ID into the page and log in.
