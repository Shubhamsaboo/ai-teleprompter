# Glass Teleprompter

A voice-following teleprompter that runs in your browser. It listens through
the mic and scrolls the script as you speak — no pedals, no manual scrolling,
no accounts, no server. Drop in a Markdown script and start reading.

## Quick start

**Hosted:** open the site, click **Try the sample** (or drop your own `.md`
file), press **Listen**, allow the microphone, and read.

**Changing scripts:** click the script title in the top bar (or the 📄
button) any time — the script panel reopens with the file picker, the
format guide, a downloadable starter template, and a "remove script"
option. `Esc` closes it. Your loaded script persists in the browser until
you replace or remove it.

**Local:**

```bash
./start.sh
```

serves it at http://localhost:8400. Any static file server works — it's
plain HTML/CSS/JS with zero dependencies. The only requirement is a secure
origin (HTTPS or localhost) because the microphone APIs demand one.

## Script format

Scripts are plain Markdown, written one thought per line:

```markdown
# ░░ COLD OPEN ░░          ← section banner (not spoken)

**~1 min 40 sec**           ← timing note (not spoken)

## Step one — the hook      ← spoken subheading

You open the tool.          ← spoken line

This is the **key** part.   ← bold = punch word, highlighted on screen

[PAUSE]                     ← cue chip: pacing direction, not spoken
[SLOW] Take this slowly.    ← cue + spoken text on one line
[SCREEN: cutaway to demo]   ← visual cue for your edit
```

Recognized cues: `[PAUSE]`, `[LONG PAUSE]`, `[SLOW]`, `[LEAN IN]`,
`[SCREEN: …]` — each renders as a color-coded glass chip that the voice
tracker skips over. Everything else on a line is treated as words you'll
speak. Whatever you load persists in your browser between visits.

## Speech engines (⚙ in the dock)

| Engine | Latency | Accuracy | Setup |
|--------|---------|----------|-------|
| **Browser** (default) | instant | good | none — Chrome's on-device model or Safari dictation |
| **Gemini Live** | ~1–2 s | best | Gemini API key |
| **Hybrid** (recommended with a key) | instant | best | Gemini API key |

Hybrid runs both at once: the browser engine drives the scroll word-by-word,
while Gemini's slower-but-smarter transcript runs a shadow tracker that
corrects the position whenever the fast engine stalls or drifts. If Gemini
drops mid-session, it degrades to browser-only without stopping.

The Gemini engine streams mic audio over WebSocket to the Live API model
your account serves (discovered automatically via ListModels — nothing
hardcoded). Your API key is stored only in your browser's localStorage and
is sent only to Google's API endpoint. Get one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## How tracking stays locked

- Fuzzy word matching tolerant of typos, mispronunciations, and accents
- Evidence-weighted advancing: common words ("you", "the") can't cause
  jumps, and far matches need the next word to corroborate — so scripts
  with repetitive phrasing don't skip lines
- Number normalization: saying "forty" matches a scripted "40",
  "four point five" matches "4.5", "twenty five" matches "25"
- Global re-localization: ad-lib, skip a section, or jump back to re-read —
  the tracker searches the whole script for the last ~8 words you said and
  re-locks, forward or backward, once it's confident

## Controls

- `Space` — start/stop listening (or pause auto-scroll)
- `↑` / `↓` — nudge the position back / forward a paragraph
- `F` — fullscreen · `M` — mirror flip (beam-splitter rigs) · `R` — restart
- `Esc` — close panels · click the title — script panel
- Modes: **Voice** (follows speech) · **Auto** (constant speed slider) ·
  **Manual** (free scroll)
- `?sim` URL flag — feeds the script to the matcher at ~150 wpm with random
  skips, for testing the tracking without a mic

## Files

- `index.html` / `style.css` / `app.js` — the whole app, no build step
- `start.sh` — local server + browser launcher
- Drop a `script.md` next to `index.html` to have it auto-load on boot
  (it's gitignored — handy for keeping a private script in a local clone)
