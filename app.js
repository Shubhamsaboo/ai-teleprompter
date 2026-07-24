/* Glass Teleprompter — voice-following prompter
 *
 * Modes:
 *  voice  — Web Speech API listens and advances a word pointer by fuzzy-matching
 *           what you say against the script; stage scrolls to keep the pointer
 *           at the reading line.
 *  auto   — constant-speed scroll (slider).
 *  manual — free scroll (wheel / arrows).
 */

const stage = document.getElementById("stage");
const scriptEl = document.getElementById("script");
const statusPill = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const micLabel = document.getElementById("mic-label");
const timerEl = document.getElementById("timer");
const progressEl = document.getElementById("progress");
const pctEl = document.getElementById("pct");
const titleEl = document.getElementById("script-title");
const subEl = document.getElementById("script-sub");
const speedGroup = document.getElementById("speed-group");
const speedInput = document.getElementById("speed");

// ---------------------------------------------------------------- state
let words = [];          // [{norm, el}] spoken-matchable words in order
let pos = 0;             // index of next expected word
let mode = "voice";      // voice | auto | manual
let listening = false;
let autoRunning = false;
let recognition = null;
let fontSize = 42;
let targetScroll = null; // px, voice mode scroll goal
let startedAt = null;    // timer
let elapsedBase = 0;

// ---------------------------------------------------------------- parsing
const CUE_CLASS = (t) => {
  const u = t.toUpperCase();
  if (u.startsWith("SCREEN")) return "screen";
  if (u.includes("PAUSE")) return "pause";
  if (u.includes("SLOW")) return "slow";
  if (u.includes("LEAN")) return "lean";
  return "";
};

function normWord(w) {
  return w
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// spoken number words → the digits the script is written with ("forty" ↔ "40")
const NUMWORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11",
  twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};
const isNum = (s) => /^\d+$/.test(s);

// normalize a raw token stream: drop empties, map number words, then merge
// "twenty five" → "25" and "four point five" → "45" (script "4.5" norms to "45")
function normalizeTokens(raws) {
  const out = [];
  for (const raw of raws) {
    let n = normWord(raw);
    if (!n) continue;
    out.push(NUMWORDS[n] || n);
  }
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[i + 1], c = out[i + 2];
    if (isNum(a) && isNum(b) && +a >= 20 && +a % 10 === 0 && +b < 10) {
      res.push(String(+a + +b));
      i += 1;
    } else if (b === "point" && isNum(a) && isNum(c)) {
      res.push(a + c);
      i += 2;
    } else {
      res.push(a);
    }
  }
  return res;
}

// Split a text run into word spans (matchable) preserving punctuation/spacing.
function wordify(text, container) {
  // split into ** bold ** segments first
  const segs = text.split(/\*\*/);
  segs.forEach((seg, i) => {
    const target =
      i % 2 === 1
        ? container.appendChild(document.createElement("strong"))
        : container;
    seg.split(/(\s+)/).forEach((tok) => {
      if (!tok) return;
      if (/^\s+$/.test(tok)) {
        target.appendChild(document.createTextNode(tok));
        return;
      }
      const norm = normWord(tok);
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = tok;
      target.appendChild(span);
      if (norm) words.push({ norm, el: span });
    });
  });
}

function makeCue(text) {
  const chip = document.createElement("span");
  chip.className = "cue " + CUE_CLASS(text);
  chip.textContent = text;
  return chip;
}

function parseScript(md, name) {
  words = [];
  pos = 0;
  scriptEl.innerHTML = "";
  let title = name || "Script";

  const lines = md.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "---") continue;

    // top-level heading: section banner (not spoken)
    if (/^#\s/.test(line)) {
      const t = line.replace(/^#\s*/, "").replace(/░/g, "").trim();
      if (!scriptEl.children.length) { title = t; continue; } // doc title → topbar
      const h = document.createElement("div");
      h.className = "sec-title";
      h.textContent = t;
      scriptEl.appendChild(h);
      continue;
    }

    // ## / ### headings: spoken subheads
    const sub = line.match(/^#{2,}\s*(.*)$/);
    if (sub) {
      const h = document.createElement("div");
      h.className = "sub-title";
      wordify(sub[1].replace(/[▸⭐]/g, "").trim(), h);
      scriptEl.appendChild(h);
      continue;
    }

    // bold-only meta lines (timing, cue key, end marker)
    if (/^\*\*[^*]+\*\*$/.test(line)) {
      const inner = line.slice(2, -2);
      if (/~|\bmin\b|\bsec\b|CUE KEY|Target runtime|^\[END\]$/i.test(inner)) {
        const m = document.createElement("div");
        m.className = "meta-line";
        m.textContent = inner;
        scriptEl.appendChild(m);
        continue;
      }
    }
    // cue-key legend line (starts with a backtick cue)
    if (/^`\[/.test(line)) {
      const m = document.createElement("div");
      m.className = "meta-line";
      m.textContent = line.replace(/`/g, "");
      scriptEl.appendChild(m);
      continue;
    }

    // standalone cue line: [PAUSE] / [SCREEN: ...] / [PAUSE — let this land]
    if (/^\[[^\]]+\]$/.test(line)) {
      const p = document.createElement("p");
      p.className = "cue-line";
      p.appendChild(makeCue(line.slice(1, -1)));
      scriptEl.appendChild(p);
      continue;
    }

    // leading cue + spoken text: "[SLOW] One distinction..."
    const lead = line.match(/^\[([^\]]+)\]\s+(.+)$/);
    const p = document.createElement("p");
    if (lead) {
      p.appendChild(makeCue(lead[1]));
      wordify(lead[2], p);
    } else {
      wordify(line, p);
    }
    scriptEl.appendChild(p);
  }

  titleEl.textContent = title;
  subEl.textContent = `${words.length} words`;
  stage.scrollTop = 0;
  targetScroll = null;
  resetTimer();
  updateProgress();
}

// ---------------------------------------------------------------- matching
const LOOKAHEAD = 22;

function close(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))
    return true;
  if (a.length >= 5 && b.length >= 5) return lev1(a, b);
  return false;
}

// levenshtein distance <= 1 check
function lev1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ring buffer of the last words actually heard (matched or not) — the probe
// used to re-locate when local tracking stalls
let recent = [];
let missStreak = 0;

function matchTokens(rawTokens) {
  const tokens = normalizeTokens(rawTokens);
  let advanced = false;
  for (const norm of tokens) {
    recent.push(norm);
    if (recent.length > 10) recent.shift();
    const end = Math.min(pos + LOOKAHEAD, words.length);
    let hit = -1;
    for (let i = pos; i < end; i++) {
      if (close(norm, words[i].norm)) { hit = i; break; }
    }
    if (hit >= 0) {
      for (let j = pos; j <= hit; j++) words[j].el.classList.add("spoken");
      words[hit].el.classList.remove("spoken");
      setCurrent(hit);
      pos = hit + 1;
      advanced = true;
      missStreak = 0;
    } else {
      missStreak++;
    }
  }
  // local tracking lost — search the whole script for where the speaker
  // actually is (handles big skips, jump-backs, ad-libbed detours)
  if (missStreak >= 6 && recent.length >= 6 && relocate()) advanced = true;
  if (advanced) {
    followCurrent();
    updateProgress();
  }
}

// Find the best in-order alignment of the last ~8 heard words anywhere in the
// script. Only jump on a confident match; slight preference for positions
// near the current one so repeated phrases don't teleport us.
function relocate() {
  const probe = recent.slice(-8);
  const need = Math.max(5, Math.ceil(probe.length * 0.65));
  let best = null;
  for (let s = 0; s < words.length; s++) {
    if (!close(probe[0], words[s].norm) && !close(probe[1], words[s].norm))
      continue; // cheap prefilter
    const end = Math.min(s + probe.length + 5, words.length);
    let k = 0, score = 0, last = s;
    for (let w = s; w < end && k < probe.length; w++) {
      if (close(probe[k], words[w].norm)) { score++; k++; last = w; }
      else if (k + 1 < probe.length && close(probe[k + 1], words[w].norm)) {
        score++; k += 2; last = w; // tolerate one misheard probe word
      }
    }
    if (score < need) continue;
    const eff = score - Math.min(1.5, Math.abs(last - pos) / 800);
    if (!best || eff > best.eff) best = { eff, score, last };
  }
  if (!best) return false;
  const idx = best.last;
  words.forEach((w, i) => {
    w.el.classList.toggle("spoken", i < idx);
    if (w.el !== words[idx].el) w.el.classList.remove("current");
  });
  currentEl = null;
  setCurrent(idx);
  pos = idx + 1;
  missStreak = 0;
  return true;
}

let currentEl = null;
function setCurrent(i) {
  if (currentEl) {
    currentEl.classList.remove("current");
    currentEl.classList.add("spoken");
  }
  currentEl = words[i].el;
  currentEl.classList.add("current");
}

function followCurrent() {
  if (!currentEl) return;
  const readingY = window.innerHeight * 0.34;
  targetScroll =
    currentEl.getBoundingClientRect().top + stage.scrollTop - readingY;
}

function updateProgress() {
  const p = words.length ? Math.round((pos / words.length) * 100) : 0;
  progressEl.style.width = p + "%";
  pctEl.textContent = p + "%";
}

// ---------------------------------------------------------------- speech
// Chrome is retiring the cloud backend behind webkitSpeechRecognition (its
// "network" error even when online). Prefer the on-device engine
// (processLocally, Chrome 139+): check availability, install the language
// pack once if needed, and only fall back to the cloud path if on-device
// isn't supported.
const LANG = "en-US";
let useLocal = null; // null = undecided, true = on-device, false = cloud
let netErrors = 0;

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

async function localAvailability() {
  const SR = getSR();
  if (!SR || typeof SR.available !== "function") return "unsupported";
  try {
    // never let a stalled engine probe hang the UI — fall back to cloud
    return await withTimeout(
      SR.available({ langs: [LANG], processLocally: true }),
      4000,
      "unsupported"
    );
  } catch (_) {
    return "unsupported";
  }
}

async function ensureLocalModel() {
  const SR = getSR();
  let state = await localAvailability();
  if (state === "available") return true;
  if (state === "downloadable" || state === "downloading") {
    setStatus("downloading speech model…", "live");
    try {
      // one-time language-pack download; generous bound, then give up
      await withTimeout(
        SR.install({ langs: [LANG], processLocally: true }),
        120000,
        false
      );
    } catch (_) {
      return false;
    }
    state = await localAvailability();
    return state === "available";
  }
  return false;
}

function buildRecognition() {
  const SR = getSR();
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = LANG;
  if (useLocal && "processLocally" in rec) rec.processLocally = true;

  let utterIndex = 0;
  let consumed = 0;

  rec.onresult = (e) => {
    netErrors = 0;
    if (statusPill.classList.contains("err"))
      setStatus(useLocal ? "listening (on-device)" : "listening", "live");
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (i < utterIndex) continue;
      const res = e.results[i];
      const tokens = res[0].transcript.trim().split(/\s+/).filter(Boolean);
      if (i > utterIndex) { utterIndex = i; consumed = 0; }
      matchTokens(tokens.slice(consumed));
      if (res.isFinal) { utterIndex = i + 1; consumed = 0; }
      else consumed = tokens.length;
    }
  };

  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("mic blocked — allow in site settings", "err");
      stopListening();
    } else if (e.error === "network") {
      netErrors++;
      if (netErrors >= 3) {
        setStatus("speech engine unreachable — try Safari", "err");
        stopListening();
      } else {
        setStatus("speech engine hiccup — retrying", "err");
      }
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      setStatus(e.error, "err");
    }
  };

  rec.onend = () => {
    // Chrome stops after silence — restart while we're meant to be live
    // (unless we just gave up after repeated engine failures)
    if (listening && netErrors < 3) {
      try { rec.start(); } catch (_) {}
    }
  };

  return rec;
}

// ---------------------------------------------------------------- engines
// Two interchangeable ears: the browser's Web Speech API (zero setup) and
// Gemini Live streaming transcription (more accurate; needs the user's key).
const settings = {
  engine: localStorage.getItem("tp-engine") || "browser",
  geminiKey: localStorage.getItem("tp-gemini-key") || "",
};
const GEMINI_MODELS = [
  "models/gemini-3.1-flash-live-preview",
  "models/gemini-2.5-flash-live-preview",
];
const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const geminiEngine = {
  ws: null, ctx: null, stream: null, node: null, src: null,
  textBuf: "", flushTimer: null,
  model: GEMINI_MODELS[0], modalities: ["TEXT"],
  gotSetup: false, attempts: 0, lastError: "",

  async start(isRetry) {
    if (!settings.geminiKey) {
      setStatus("add your Gemini API key in ⚙ settings", "err");
      return false;
    }
    if (!isRetry) {
      this.model = GEMINI_MODELS[0];
      this.modalities = ["TEXT"];
      this.attempts = 0;
    }
    this.gotSetup = false;
    this.lastError = "";
    this.attempts++;
    setStatus(isRetry ? "retrying Gemini…" : "connecting to Gemini…", "live");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (_) {
      setStatus("mic blocked — allow in site settings", "err");
      return false;
    }
    const ws = new WebSocket(GEMINI_WS + "?key=" + encodeURIComponent(settings.geminiKey));
    this.ws = ws;
    const opened = await new Promise((r) => {
      ws.onopen = () => r(true);
      ws.onerror = () => r(false);
      setTimeout(() => r(false), 8000);
    });
    if (!opened) {
      setStatus("Gemini connection failed — check key / network", "err");
      this.cleanup();
      return false;
    }
    ws.send(
      JSON.stringify({
        setup: {
          model: this.model,
          generationConfig: { responseModalities: this.modalities },
          systemInstruction: {
            parts: [{ text: "You are a silent transcription service. Never reply to the audio." }],
          },
          inputAudioTranscription: {},
        },
      })
    );
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : await ev.data.text();
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!this.gotSetup) console.debug("gemini <-", raw.slice(0, 300));
      if (msg.setupComplete) {
        this.gotSetup = true;
        setStatus("listening (Gemini)", "live");
      }
      if (msg.error) {
        this.lastError =
          (msg.error.message || JSON.stringify(msg.error)).slice(0, 200);
      }
      const t = msg.serverContent && msg.serverContent.inputTranscription &&
                msg.serverContent.inputTranscription.text;
      if (t) this.onText(t);
    };
    ws.onclose = (e) => {
      if (!listening || settings.engine !== "gemini") return;
      const reason = e.reason || this.lastError || "";
      console.warn("gemini closed", e.code, reason);
      // setup was rejected — adapt and retry instead of guessing at the cause:
      // an unknown model → next model; otherwise assume the modality was the
      // problem (native-audio models refuse TEXT) and retry with AUDIO
      const fatal = /api key|permission|quota|billing|suspended/i.test(reason);
      if (!this.gotSetup && this.attempts < 3 && !fatal) {
        if (/model/i.test(reason) && this.model !== GEMINI_MODELS[1]) {
          this.model = GEMINI_MODELS[1];
        } else {
          this.modalities = ["AUDIO"];
        }
        this.cleanup();
        this.start(true).then((ok) => { if (!ok) stopListening(); });
        return;
      }
      setStatus(
        reason
          ? "Gemini: " + reason.slice(0, 90)
          : this.gotSetup
            ? "Gemini disconnected — press Listen to reconnect"
            : "Gemini refused setup (code " + e.code + ") — see console",
        "err"
      );
      stopListening();
    };

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node = proc;
    const inRate = this.ctx.sampleRate;
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== 1) return;
      const pcm = downsampleTo16k(e.inputBuffer.getChannelData(0), inRate);
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data: b64FromInt16(pcm), mimeType: "audio/pcm;rate=16000" },
          },
        })
      );
    };
    this.src.connect(proc);
    proc.connect(this.ctx.destination); // required for ScriptProcessor to fire; outputs silence
    return true;
  },

  // transcription arrives as fragments; emit whole words, keep the tail until
  // the next fragment (or a short quiet gap) completes it
  onText(t) {
    this.textBuf += t;
    const parts = this.textBuf.split(/\s+/);
    this.textBuf = parts.pop() || "";
    if (parts.length) matchTokens(parts);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 800);
  },
  flush() {
    if (this.textBuf) {
      matchTokens([this.textBuf]);
      this.textBuf = "";
    }
  },

  stop() {
    this.flush();
    this.cleanup();
  },
  cleanup() {
    clearTimeout(this.flushTimer);
    try { this.node && this.node.disconnect(); } catch (_) {}
    try { this.src && this.src.disconnect(); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
    if (this.stream) this.stream.getTracks().forEach((tr) => tr.stop());
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch (_) {}
    }
    this.ws = this.ctx = this.stream = this.node = this.src = null;
    this.textBuf = "";
  },
};

function downsampleTo16k(f32, inRate) {
  const ratio = inRate / 16000;
  const out = new Int16Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const v = f32[Math.floor(i * ratio)];
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

function b64FromInt16(pcm) {
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}

async function startListening() {
  micBtn.classList.add("live");
  micLabel.textContent = "Stop";
  listening = true;
  if (settings.engine === "gemini") {
    const ok = await geminiEngine.start();
    if (!ok) { stopListening(); return; }
  } else {
    if (!getSR()) {
      setStatus("speech API unavailable — use Chrome/Safari", "err");
      stopListening();
      return;
    }
    if (useLocal == null) {
      setStatus("checking speech engine…", "live");
      useLocal = await ensureLocalModel();
      recognition = null; // rebuild with the decided engine
    }
    if (!recognition) recognition = buildRecognition();
    netErrors = 0;
    try { recognition.start(); } catch (_) {}
    setStatus(useLocal ? "listening (on-device)" : "listening", "live");
  }
  startTimer();
}

function stopListening() {
  listening = false;
  if (recognition) { try { recognition.stop(); } catch (_) {} }
  geminiEngine.cleanup();
  micBtn.classList.remove("live");
  micLabel.textContent = "Listen";
  if (!statusPill.classList.contains("err")) setStatus("paused");
  pauseTimer();
}

function setStatus(text, cls) {
  statusPill.textContent = text;
  statusPill.className = "status-pill" + (cls ? " " + cls : "");
}

// ---------------------------------------------------------------- scrolling
let lastTick = null;
function tick(now) {
  const dt = lastTick == null ? 0.016 : Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  if (mode === "voice" && targetScroll != null) {
    const diff = targetScroll - stage.scrollTop;
    if (Math.abs(diff) > 0.6) {
      // ease toward target, capped so it glides like a prompter (px/sec based,
      // so behavior is identical on 60Hz and 120Hz displays)
      const step =
        Math.sign(diff) * Math.min(Math.abs(diff) * 4.5 * dt, 900 * dt);
      stage.scrollTop += step;
    }
  } else if (mode === "auto" && autoRunning) {
    stage.scrollTop += Number(speedInput.value) * dt;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- timer
function startTimer() {
  if (!startedAt) startedAt = Date.now();
}
function pauseTimer() {
  if (startedAt) {
    elapsedBase += Date.now() - startedAt;
    startedAt = null;
  }
}
function resetTimer() {
  startedAt = null;
  elapsedBase = 0;
  timerEl.textContent = "00:00";
}
setInterval(() => {
  const ms = elapsedBase + (startedAt ? Date.now() - startedAt : 0);
  const s = Math.floor(ms / 1000);
  timerEl.textContent =
    String(Math.floor(s / 60)).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0");
}, 500);

// ---------------------------------------------------------------- controls
micBtn.addEventListener("click", () => {
  if (mode !== "voice") setMode("voice");
  listening ? stopListening() : startListening();
});

const seg = document.getElementById("mode-seg");
seg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setMode(b.dataset.mode);
});

function setMode(m) {
  mode = m;
  [...seg.children].forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  speedGroup.classList.toggle("show", m === "auto");
  if (m !== "voice" && listening) stopListening();
  if (m === "auto") {
    autoRunning = true;
    setStatus("auto-scroll", "live");
    startTimer();
  } else {
    autoRunning = false;
  }
  if (m === "manual") { setStatus("manual"); pauseTimer(); }
  if (m === "voice") setStatus(listening ? "listening" : "idle", listening ? "live" : "");
}

document.getElementById("font-plus").addEventListener("click", () => setFont(fontSize + 3));
document.getElementById("font-minus").addEventListener("click", () => setFont(fontSize - 3));
function setFont(px) {
  fontSize = Math.max(24, Math.min(72, px));
  document.documentElement.style.setProperty("--fs", fontSize + "px");
  followCurrent();
}

const mirrorBtn = document.getElementById("mirror-btn");
mirrorBtn.addEventListener("click", toggleMirror);
function toggleMirror() {
  stage.classList.toggle("mirrored");
  mirrorBtn.classList.toggle("on");
}

document.getElementById("top-btn").addEventListener("click", restart);
function restart() {
  pos = 0;
  targetScroll = null;
  currentEl = null;
  words.forEach((w) => w.el.classList.remove("spoken", "current"));
  stage.scrollTo({ top: 0, behavior: "smooth" });
  resetTimer();
  updateProgress();
}

const fsBtn = document.getElementById("fs-btn");
fsBtn.addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

// keyboard
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  switch (e.code) {
    case "Space":
      e.preventDefault();
      if (mode === "auto") {
        autoRunning = !autoRunning;
        setStatus(autoRunning ? "auto-scroll" : "paused", autoRunning ? "live" : "");
        autoRunning ? startTimer() : pauseTimer();
      } else {
        if (mode !== "voice") setMode("voice");
        listening ? stopListening() : startListening();
      }
      break;
    case "ArrowDown":
      e.preventDefault();
      jumpParagraph(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      jumpParagraph(-1);
      break;
    case "KeyF": toggleFullscreen(); break;
    case "KeyM": toggleMirror(); break;
    case "KeyR": restart(); break;
  }
});

// jump the voice pointer / scroll by paragraph
function jumpParagraph(dir) {
  const paras = [...scriptEl.querySelectorAll("p, .sub-title")].filter((p) =>
    p.querySelector(".w")
  );
  if (!paras.length) return;
  const anchor = currentEl || paras[0].querySelector(".w");
  const anchorTop = anchor.getBoundingClientRect().top + stage.scrollTop;
  let idx = paras.findIndex(
    (p) => p.getBoundingClientRect().top + stage.scrollTop > anchorTop + 4
  );
  if (idx === -1) idx = paras.length;
  const target = paras[Math.max(0, Math.min(paras.length - 1, dir > 0 ? idx : idx - 2))];
  const firstWord = target.querySelector(".w");
  const wi = words.findIndex((w) => w.el === firstWord);
  if (wi === -1) return;
  words.forEach((w, i) => {
    w.el.classList.toggle("spoken", i < wi);
    w.el.classList.remove("current");
  });
  currentEl = null;
  setCurrent(wi);
  pos = wi + 1;
  followCurrent();
  updateProgress();
  if (mode !== "voice") {
    stage.scrollTo({ top: targetScroll, behavior: "smooth" });
  }
}

// settings popover
const settingsBtn = document.getElementById("settings-btn");
const settingsPop = document.getElementById("settings-pop");
const keyInput = document.getElementById("gemini-key");

settingsBtn.addEventListener("click", () => {
  settingsPop.hidden = !settingsPop.hidden;
  settingsBtn.classList.toggle("on", !settingsPop.hidden);
});
document.addEventListener("click", (e) => {
  if (
    !settingsPop.hidden &&
    !settingsPop.contains(e.target) &&
    !settingsBtn.contains(e.target)
  ) {
    settingsPop.hidden = true;
    settingsBtn.classList.remove("on");
  }
});

document.querySelectorAll('input[name="engine"]').forEach((r) => {
  r.checked = r.value === settings.engine;
  r.addEventListener("change", () => {
    if (!r.checked) return;
    settings.engine = r.value;
    localStorage.setItem("tp-engine", r.value);
    if (listening) stopListening();
    setStatus(r.value === "gemini" ? "engine: Gemini Live" : "engine: browser");
  });
});
keyInput.value = settings.geminiKey;
// save on every keystroke/paste, not just blur — otherwise paste-then-click-
// Listen could connect with an empty stored key
["input", "change"].forEach((ev) =>
  keyInput.addEventListener(ev, () => {
    settings.geminiKey = keyInput.value.trim();
    localStorage.setItem("tp-gemini-key", settings.geminiKey);
  })
);

// keep the current word on the reading line through window resizes
window.addEventListener("resize", followCurrent);

// manual scrolling interrupts voice-follow until next match
stage.addEventListener(
  "wheel",
  () => {
    if (mode === "voice") targetScroll = null;
  },
  { passive: true }
);

// ---------------------------------------------------------------- loading
const fileInput = document.getElementById("file-input");
fileInput.addEventListener("change", async () => {
  const f = fileInput.files[0];
  if (f) parseScript(await f.text(), f.name.replace(/\.(md|txt|markdown)$/i, ""));
});

["dragenter", "dragover"].forEach((ev) =>
  document.body.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((ev) =>
  document.body.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && e.relatedTarget) return;
    document.body.classList.remove("dragging");
  })
);
document.body.addEventListener("drop", async (e) => {
  const f = e.dataTransfer.files[0];
  if (f) parseScript(await f.text(), f.name.replace(/\.(md|txt|markdown)$/i, ""));
});

// boot: load bundled script
fetch("script.md")
  .then((r) => (r.ok ? r.text() : Promise.reject()))
  .then((md) => parseScript(md, "Loop Engineering"))
  .catch(() => {
    subEl.textContent = "no script loaded — drop a .md file";
  });

// ---------------------------------------------------------------- simulation (?sim)
// Dev aid: feeds script words as fake speech so the follow logic can be tested
// without a mic. Open with ?sim to enable.
if (new URLSearchParams(location.search).has("sim")) {
  const b = document.createElement("button");
  b.textContent = "▶ sim";
  b.className = "icon-btn";
  b.style.position = "fixed";
  b.style.right = "16px";
  b.style.bottom = "84px";
  b.style.zIndex = "50";
  document.body.appendChild(b);
  let simOn = false;
  b.addEventListener("click", () => {
    simOn = !simOn;
    b.classList.toggle("on", simOn);
    if (simOn) feed();
  });
  function feed() {
    if (!simOn || pos >= words.length) return;
    // speak 2–4 words ahead, occasionally skipping one (tests fuzziness)
    const n = 2 + Math.floor(Math.random() * 3);
    const toks = [];
    for (let i = pos, c = 0; i < words.length && c < n; i++, c++) {
      if (Math.random() < 0.12) continue; // skipped word
      toks.push(words[i].norm);
    }
    matchTokens(toks);
    setTimeout(feed, (n * 60000) / 150); // ~150 wpm
  }
}
