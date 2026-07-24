# Glass Teleprompter

A voice-following teleprompter for the Mac. It listens to you through the mic
and scrolls the script as you speak — no pedals, no manual scrolling.

## Run it

```bash
./start.sh
```

That serves the app at http://localhost:8400 and opens Chrome. The first time
you hit **Listen**, Chrome will ask for microphone access — allow it.

> Voice mode uses the browser's Web Speech API in **Chrome** or Safari.
> On modern Chrome it prefers the **on-device** engine: the first time you hit
> Listen, Chrome may download its English speech model (one-time, then voice
> mode works fully offline). Chrome's old cloud engine is being retired and
> often fails with a `network` error even when you're online — that's why
> on-device is the default here. If the status pill says "speech engine
> unreachable", update Chrome (150+) or use Safari, whose dictation engine
> also runs on-device.

## Using it

1. Hit **Listen** (or press `Space`) and start reading from the reading line (▸).
2. The prompter matches your words and glides the script so your current word
   stays at the line. Skipped or flubbed words are fine — it fuzzy-matches and
   catches up.
3. `[PAUSE]`, `[SLOW]`, `[LEAN IN]`, and `[SCREEN]` cues show as colored glass
   chips; they're ignored by the voice matcher.

### Modes

| Mode   | What it does                                      |
|--------|---------------------------------------------------|
| Voice  | Follows your speech (default)                     |
| Auto   | Constant-speed scroll; speed slider appears       |
| Manual | Free scroll with the wheel / arrow keys           |

### Keys

- `Space` — start/stop listening (or pause auto-scroll)
- `↑` / `↓` — jump the position back / forward a paragraph
- `F` — fullscreen · `M` — mirror flip · `R` — restart from the top

### Speech engines (⚙ in the dock)

| Engine | Accuracy | Setup |
|--------|----------|-------|
| **Browser** (default) | good | none — Chrome's on-device model or Safari dictation |
| **Gemini Live** | best | paste your API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

Gemini Live streams your mic audio over WebSocket to
`gemini-3.1-flash-live-preview` and feeds its transcription to the same
matcher. The key is stored only in your browser's localStorage and is sent
only to Google's API endpoint.

### How tracking stays locked

- Fuzzy word matching (typos/mispronunciations tolerated, ~22-word lookahead)
- Number normalization: saying "forty" matches a scripted "40",
  "four point five" matches "4.5", "twenty five" matches "25"
- **Global re-localization**: if you ad-lib, skip a section, or jump back to
  re-read a line, the tracker searches the whole script for the last ~8 words
  you said and re-locks — forward or backward — once it's confident.

### Loading a different script

Drag any `.md`/`.txt` onto the window, or use the 📄 button in the top bar.
The parser understands the teleprompter markdown conventions used in
`script.md`: `#` section banners, `**bold**` punch words, and `[CUE]` lines.

## Files

- `index.html` / `style.css` / `app.js` — the app (no build step, no deps)
- `script.md` — the currently bundled script (Loop Engineering)
- `start.sh` — local server + browser launcher

## Testing without a mic

Open http://localhost:8400/?sim and hit the small **▶ sim** button — it feeds
the script to the matcher at ~150 wpm with random skipped words.
