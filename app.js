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

function matchTokens(tokens) {
  let advanced = false;
  for (const t of tokens) {
    const norm = normWord(t);
    if (!norm) continue;
    const end = Math.min(pos + LOOKAHEAD, words.length);
    for (let i = pos; i < end; i++) {
      if (close(norm, words[i].norm)) {
        for (let j = pos; j <= i; j++) words[j].el.classList.add("spoken");
        words[i].el.classList.remove("spoken");
        setCurrent(i);
        pos = i + 1;
        advanced = true;
        break;
      }
    }
  }
  if (advanced) {
    followCurrent();
    updateProgress();
  }
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
function buildRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";

  let utterIndex = 0;
  let consumed = 0;

  rec.onresult = (e) => {
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
      setStatus("mic blocked", "err");
      stopListening();
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      setStatus(e.error, "err");
    }
  };

  rec.onend = () => {
    // Chrome stops after silence — restart while we're meant to be live
    if (listening) {
      try { rec.start(); } catch (_) {}
    }
  };

  return rec;
}

function startListening() {
  if (!recognition) recognition = buildRecognition();
  if (!recognition) {
    setStatus("speech API unavailable — use Chrome/Safari", "err");
    return;
  }
  try { recognition.start(); } catch (_) {}
  listening = true;
  micBtn.classList.add("live");
  micLabel.textContent = "Stop";
  setStatus("listening", "live");
  startTimer();
}

function stopListening() {
  listening = false;
  if (recognition) { try { recognition.stop(); } catch (_) {} }
  micBtn.classList.remove("live");
  micLabel.textContent = "Listen";
  setStatus("paused");
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
