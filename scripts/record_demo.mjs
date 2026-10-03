// Record the demo video: drives a throwaway headless Chrome (temporary profile) over the DevTools protocol,
// injects captions and a redaction layer, captures screencast frames at full device resolution (2880x1800), and
// builds docs/demo-hd.mp4 (2880x1800 with voice-over, for YouTube; not in git), docs/demo.mp4 (1440x900) and
// docs/demo.gif with ffmpeg. Full-resolution stills of the key states go to docs/screenshots/hd/.
//
//   Dry run against a local simulator (no keys, nothing leaves the machine except the TTS text):
//     APP_URL=http://127.0.0.1:8793 OUT_DIR=/some/scratch node scripts/record_demo.mjs
//   Real take on the public deployment (live PayPal sandbox, paired from this terminal):
//     LIVE=1 node scripts/record_demo.mjs
//   Re-run only the assembly of a kept take (KEEP_WORK=1, or a failed encode keeps it):
//     ASSEMBLE_ONLY=/path/to/paceline-rec-XXXX node scripts/record_demo.mjs
//
// Voice-over: one clip per row of docs/narration.md, generated with edge-tts (hosted neural TTS, no account;
// EDGE_TTS=path to the CLI, TTS_VOICE, cached in TTS_CACHE). Each scene is held until its clip has finished.
// NARRATION=0 records without voice; NARRATION_ONLY=1 only generates the clips and prints their durations.
//
// Cursor: drawn in post, not in the page. The take records where the pointer goes and when it clicks (the same
// CSS-px points the mouse events are sent to); the encoder overlays a cursor sprite at 30 fps with eased motion
// and a click pulse. So motion does not depend on the capture rate, and stills never contain a cursor.
//
// Node 22+ (global WebSocket). The cursor, captions, title card, terminal card and redaction layer exist for the
// video only; they are not part of the app.
//
// LIVE=1 rules, all enforced below:
//   * the operator token is never typed into the browser: the page shows a pairing code, the token is read from
//     .env by the shell command and posted with curl to https://paceline.gotclass.xyz only (never echoed);
//   * the payment is recorded with `scripts/try-sandbox.ts record-payment` (no sandbox.paypal.com login);
//   * any e-mail address that is not a ".example" brief address (that is, the sandbox buyer) is covered.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.env.LIVE === "1";
const APP = (process.env.APP_URL || (LIVE ? "https://paceline.gotclass.xyz" : "http://127.0.0.1:8793")).replace(/\/$/, "");
const OUT = process.env.OUT_DIR || join(ROOT, "docs");
const SHOTS = process.env.SHOTS_DIR || join(tmpdir(), "paceline-demo-shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9344;
const W = 1440, H = 900, BAR = 60; // the caption bar takes the bottom 60 px of the frame
const DPR = 2, CW = W * DPR, CH = H * DPR; // captured frames and stills are 2880x1800
const PUBLIC = "https://paceline.gotclass.xyz";
if (LIVE && APP !== PUBLIC) throw new Error("LIVE=1 only runs against " + PUBLIC);
const HD_SHOTS = process.env.HD_SHOTS_DIR || join(OUT, "screenshots", "hd");
// Stills kept at full resolution (2880x1800, caption bar included): recorder shot name -> file in HD_SHOTS.
const HD_NAMES = {
  "a2-plan-review.jpg": "15-live-plan-review.jpg",
  "a3-approval-gate.jpg": "16-live-invoice-approval.jpg",
  "a5-webhook-unlock.jpg": "18-live-webhook-paid-unlocks-next.jpg",
  "b1b-reminder-draft.jpg": "06-overdue-reschedule-and-reminder.jpg",
  "b2-group-by-client.jpg": "07-ledger-group-by-client.jpg",
};
const FF = ["-n", "10", "ffmpeg", "-y", "-loglevel", "error", "-threads", "2", "-filter_threads", "2"]; // run through `nice`
// Output colour: limited-range BT.601 (what the JPEG frames are decoded as), tagged so players and YouTube agree.
const COLOR = ["-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "smpte170m", "-color_primaries", "bt709", "-color_trc", "bt709"];
const FPS = 30;
const ASSEMBLE_ONLY = process.env.ASSEMBLE_ONLY || "";
const NARR = process.env.NARRATION !== "0";
const VOICE = process.env.TTS_VOICE || "en-US-AndrewNeural";
const RATE = process.env.TTS_RATE || "+5%";
const EDGE_TTS = process.env.EDGE_TTS || "edge-tts";
const TTS_CACHE = process.env.TTS_CACHE || join(tmpdir(), "paceline-tts");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(HD_SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const nowS = () => Date.now() / 1000; // same clock as the screencast frame timestamps (seconds since the epoch)

/* ───────────── narration clips ───────────── */

let CLIPS = {}; // key -> { text, file, dur }
async function loadNarration() {
  const md = readFileSync(join(ROOT, "docs", "narration.md"), "utf8");
  const clips = {};
  for (const line of md.split("\n")) {
    const m = line.match(/^\|[^|]*\|\s*`([a-z0-9-]+)`\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) clips[m[1]] = { text: m[2] };
  }
  if (!Object.keys(clips).length) throw new Error("no narration rows found in docs/narration.md");
  mkdirSync(TTS_CACHE, { recursive: true });
  for (const [key, c] of Object.entries(clips)) {
    c.file = join(TTS_CACHE, `${key}-${createHash("sha1").update(`${VOICE}|${RATE}|${c.text}`).digest("hex").slice(0, 10)}.mp3`);
    for (let attempt = 1; !existsSync(c.file); attempt++) {
      const r = spawnSync(EDGE_TTS, ["--voice", VOICE, `--rate=${RATE}`, "--text", c.text, "--write-media", c.file + ".part"], { stdio: ["ignore", "ignore", "pipe"] });
      if (r.status === 0) { renameSync(c.file + ".part", c.file); break; }
      if (attempt >= 3) throw new Error(`edge-tts failed for "${key}": ${(r.stderr || r.error || "").toString().slice(-300)}`);
      await sleep(1500 * attempt);
    }
    c.dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", c.file]).toString());
  }
  return clips;
}
if (NARR && !ASSEMBLE_ONLY) {
  CLIPS = await loadNarration();
  const total = Object.values(CLIPS).reduce((a, c) => a + c.dur, 0);
  log(`narration: ${Object.keys(CLIPS).length} clips, voice ${VOICE} (rate ${RATE}), ${total.toFixed(1)} s in total (variants included)`);
  if (process.env.NARRATION_ONLY) {
    for (const [k, c] of Object.entries(CLIPS)) console.log(`${c.dur.toFixed(2).padStart(6)} s  ${k}`);
    process.exit(0);
  }
}

const work = ASSEMBLE_ONLY || mkdtempSync(join(tmpdir(), "paceline-rec-"));
const framesDir = join(work, "frames");
const spritesDir = join(work, "sprites");
if (!ASSEMBLE_ONLY) mkdirSync(framesDir);

let chrome = null;
function startChrome() {
  chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--mute-audio",
    `--user-data-dir=${join(work, "profile")}`, `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, "about:blank",
  ], { stdio: "ignore" });
}

let ws, nextId = 1;
const pending = new Map();
const frames = [];
let recording = false, speedup = 1;
const marks = {};
let invoiceNo = "";
const cursorEv = []; // { T (s), type: "move" | "click" | "vis", ... } in CSS px
const narrEv = []; // { T (s), key }
let cur = { x: 760, y: 500 };
let narrEnd = 0; // wall-clock ms when the current clip (plus a beat) has finished

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed");
  return r.result.value;
}

/* ───────────── injected overlays (video only) ───────────── */

const OVERLAY_JS = `(() => {
  if (document.getElementById('__cap')) return;
  const css = \`
    .app{height:calc(100dvh - ${BAR}px)!important}
    .scrim{inset:0 0 ${BAR}px 0!important}
    .toasts{bottom:${BAR + 52}px!important}
    #__cap{position:fixed;left:0;right:0;bottom:0;height:${BAR}px;z-index:99998;display:flex;align-items:center;justify-content:center;
      background:#16181d;color:#fff;font:600 19px/1.3 -apple-system,'Helvetica Neue',Helvetica,sans-serif;padding:0 36px;text-align:center;
      pointer-events:none;border-top:1px solid #2a2e36;transition:opacity .25s}
    #__cap small{font-weight:600;color:#7aa7ff;margin-right:10px;letter-spacing:.04em;text-transform:uppercase;font-size:12px}
    #__blur{position:fixed;inset:0;z-index:99990;pointer-events:none}
    #__blur i{position:fixed;display:block;border-radius:4px;background:#9aa1ad;box-shadow:0 0 0 1px #7d8491 inset}
    #__card{position:fixed;inset:0;z-index:99997;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
      background:radial-gradient(1200px 700px at 50% 40%,#1b2540,#0e1118);color:#fff;font-family:-apple-system,'Helvetica Neue',Helvetica,sans-serif;
      text-align:center;padding:0 80px;transition:opacity .6s}
    #__card h1{font-size:64px;margin:0;letter-spacing:-.02em}
    #__card p{font-size:26px;margin:0;color:#cdd6ea;max-width:980px;line-height:1.35}
    #__card small{font-size:17px;color:#8fa0c4;margin-top:10px}
    #__term{position:fixed;left:50%;top:44%;width:900px;transform:translate(-50%,-50%);z-index:99996;border-radius:12px;overflow:hidden;
      background:#0d1117;color:#e6edf3;box-shadow:0 24px 80px rgba(0,0,0,.45),0 0 0 1px #30363d;font:14px/1.55 ui-monospace,Menlo,monospace;display:none}
    #__term .bar{background:#161b22;padding:9px 14px;color:#9da7b3;font:600 12px -apple-system,Helvetica,sans-serif;letter-spacing:.03em}
    #__term pre{margin:0;padding:16px 18px 18px;white-space:pre-wrap;word-break:break-all;min-height:150px}
    #__term .k{color:#7ee787}#__term .d{color:#8b949e}
    #__term .blink{display:inline-block;width:8px;height:15px;background:#e6edf3;vertical-align:-2px;animation:__b 1s steps(1) infinite}
    @keyframes __b{50%{opacity:0}}
    #__tick{position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:99999;pointer-events:none;animation:__t .2s steps(1) infinite}
    @keyframes __t{0%{background:#16181d}50%{background:#16181e}}
  \`;
  // A constructable stylesheet: the production CSP (style-src with a nonce) blocks injected <style> elements,
  // but not CSSOM-created sheets.
  const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const de = document.documentElement;
  const cap = document.createElement('div'); cap.id = '__cap'; cap.style.opacity = 0; de.appendChild(cap);
  const term = document.createElement('div'); term.id = '__term';
  term.innerHTML = '<div class="bar">Terminal on the recording machine (operator tool)</div><pre></pre>'; de.appendChild(term);
  const card = document.createElement('div'); card.id = '__card'; card.style.opacity = 0; card.style.display = 'none'; de.appendChild(card);
  const layer = document.createElement('div'); layer.id = '__blur'; de.appendChild(layer);
  const tick = document.createElement('div'); tick.id = '__tick'; de.appendChild(tick); // keeps frames flowing so static holds keep their real length

  /* Redaction: cover every e-mail address that is not a ".example" brief address (the sandbox buyer's address
     is shown in the approval card and in the action log). Rectangles come from the text itself, so they follow
     scrolling and re-renders; nothing is wrapped or changed in the page's own DOM. */
  const RE = /[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}/g;
  const brief = (m) => /\\.example$/i.test(m.split('@')[1]);
  window.__blurStats = { found: 0, boxes: 0, leaks: 0 };
  const scanRoots = () => [...document.querySelectorAll('.agent, .scrim, .toasts, .ledger-card, .plan-card')];
  const walk = (root, fn) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) fn(n);
  };
  let boxes = [];
  const scan = () => {
    const rects = []; let found = 0;
    for (const root of scanRoots()) {
      walk(root, (n) => {
        const t = n.nodeValue; if (!t || t.indexOf('@') < 0) return;
        const p = n.parentElement; if (!p) return;
        const clip = p.getBoundingClientRect();
        RE.lastIndex = 0; let m;
        while ((m = RE.exec(t))) {
          if (brief(m[0])) continue;
          found++;
          const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          for (const q of r.getClientRects()) {
            const x1 = Math.max(q.left, clip.left), x2 = Math.min(q.right, clip.right), y1 = Math.max(q.top, clip.top), y2 = Math.min(q.bottom, clip.bottom);
            if (x2 - x1 > 1 && y2 - y1 > 1) rects.push([x1 - 2, y1 - 1, x2 - x1 + 4, y2 - y1 + 2]);
          }
        }
      });
      for (const el of root.querySelectorAll('input, textarea')) {
        const v = el.value || '';
        RE.lastIndex = 0; let m; let bad = false;
        while ((m = RE.exec(v))) if (!brief(m[0])) bad = true;
        if (bad) { found++; const q = el.getBoundingClientRect(); rects.push([q.left, q.top, q.width, q.height]); }
      }
    }
    // whole-page check: addresses outside the scanned areas would be a leak
    let all = 0; walk(document.body, (n) => { const t = n.nodeValue; if (t && t.indexOf('@') >= 0) { RE.lastIndex = 0; let m; while ((m = RE.exec(t))) if (!brief(m[0])) all++; } });
    window.__blurStats = { found, boxes: rects.length, leaks: Math.max(0, all - found) };
    const key = rects.map((r) => r.map(Math.round).join(',')).join('|');
    if (key === boxes.key) return;
    boxes = rects; boxes.key = key;
    layer.textContent = '';
    for (const [x, y, w, h] of rects) {
      const i = document.createElement('i');
      i.style.left = x + 'px'; i.style.top = y + 'px'; i.style.width = w + 'px'; i.style.height = h + 'px';
      layer.appendChild(i);
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  addEventListener('scroll', scan, true);
  addEventListener('resize', scan);
  const loop = () => { scan(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
})()`;

const ensureOverlays = () => js(OVERLAY_JS);
const caption = (t, tag) => js(`(()=>{const c=document.getElementById('__cap'); c.innerHTML=${JSON.stringify((tag ? `<small>${tag}</small>` : "") + "<span></span>")}; c.lastChild.textContent=${JSON.stringify(t)}; c.style.opacity=${t ? 1 : 0};})()`);
// Read time: about 15 characters a second plus a beat, never under 2.4 s.
const readMs = (t) => Math.max(2400, 900 + t.length * 62);
/* Narration: a scene lasts until its clip has been spoken (plus a beat). The next caption, a sped-up wait and a
   cut all wait for narrDone(), so speech is never cut off and clips never overlap in the video. */
async function narrDone() {
  const left = narrEnd - Date.now();
  if (left > 0) await sleep(left);
}
function narrate(key) {
  if (!NARR) return;
  const c = CLIPS[key];
  if (!c) throw new Error("no narration clip for " + key);
  narrEv.push({ T: nowS(), key });
  narrEnd = Date.now() + c.dur * 1000 + 300;
}
async function say(t, opts = {}) {
  await narrDone();
  await caption(t, opts.tag);
  if (opts.n) narrate(opts.n);
  await sleep(opts.ms ?? readMs(t));
}

/* Cursor (drawn in post): record the glide and clicks; the page itself shows no cursor. */
const cursorVisible = (on) => cursorEv.push({ T: nowS(), type: "vis", on });
async function moveTo(x, y, wait = 650) {
  const dist = Math.hypot(x - cur.x, y - cur.y);
  const dur = dist < 2 ? 0 : Math.min(0.7, 0.42 + dist / 2600); // seconds, eased in and out
  cursorEv.push({ T: nowS(), type: "move", x0: cur.x, y0: cur.y, x1: x, y1: y, dur });
  cur = { x, y };
  await sleep(Math.max(wait, dur * 1000 + 120));
}
const SPR = 80, ANCHOR = 32, PULSE_FRAMES = 14; // sprite box and cursor tip in CSS px (x2 in the video); pulse length in frames
function spriteSvg(stage) { // stage null: the arrow; 0..PULSE_FRAMES-1: arrow plus click pulse
  let ring = "", s = 1.1;
  if (stage !== null) {
    const u = stage / (PULSE_FRAMES - 1), e = 1 - Math.pow(1 - u, 3);
    ring = `<circle cx="${ANCHOR}" cy="${ANCHOR}" r="${(5 + 17 * e).toFixed(2)}" fill="rgba(47,107,255,${(0.16 * (1 - u)).toFixed(3)})" stroke="rgba(47,107,255,${(0.7 * (1 - u)).toFixed(3)})" stroke-width="2.5"/>`;
    if (stage < 4) s = 1.0; // pressed
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SPR}" height="${SPR}" viewBox="0 0 ${SPR} ${SPR}">${ring}` +
    `<g transform="translate(${ANCHOR} ${ANCHOR}) scale(${s}) translate(-4 -2)" style="filter:drop-shadow(0 1px 1.2px rgba(0,0,0,.35))">` +
    `<path d="M4 2l15 9.5-6.6 1.3 3.9 7.4-2.7 1.4-3.9-7.4L4 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></g></svg>`;
}
async function renderSprites() { // on about:blank, before anything else: transparent PNGs at device scale
  mkdirSync(spritesDir, { recursive: true });
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const all = { cur: spriteSvg(null) };
  for (let k = 0; k < PULSE_FRAMES; k++) all[`p${k}`] = spriteSvg(k);
  for (const [name, svg] of Object.entries(all)) {
    await js(`(()=>{document.documentElement.style.background='transparent'; document.body.style.cssText='margin:0;background:transparent'; document.body.innerHTML=${JSON.stringify(svg)};})()`);
    await sleep(60);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: SPR, height: SPR, scale: 1 } });
    writeFileSync(join(spritesDir, `${name}.png`), Buffer.from(r.data, "base64"));
  }
  await send("Emulation.setDefaultBackgroundColorOverride", {});
  log(`cursor sprites: ${Object.keys(all).length} (${SPR * DPR}x${SPR * DPR})`);
}
const rectOf = (finder) => js(`(()=>{const e=(${finder}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,l:r.left,t:r.top,w:r.width,h:r.height};})()`);
const byText = (sel, text, exact = false) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>{const t=e.textContent.trim(); return ${exact ? "t===" : "t.startsWith("}${JSON.stringify(text)}${exact ? "" : ")"} && !e.disabled;})`;
async function mouse(type, x, y, buttons = 1) {
  await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
}
async function clickEl(finder) {
  const p = await rectOf(finder);
  if (!p) throw new Error("not found: " + finder.slice(0, 120));
  await moveTo(p.x, p.y);
  cursorEv.push({ T: nowS(), type: "click", x: p.x, y: p.y });
  await mouse("mousePressed", p.x, p.y);
  await sleep(70);
  await mouse("mouseReleased", p.x, p.y, 0);
  await sleep(280);
}
async function pointAt(finder, wait = 700) {
  const p = await rectOf(finder);
  if (p) await moveTo(p.x, p.y, wait);
  return p;
}
async function waitFor(expr, timeoutMs = 240000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(`!!(${expr})`)) return Date.now() - t0;
    await sleep(250);
  }
  throw new Error("timeout waiting for " + label.slice(0, 160));
}
async function scrollInto(sel, top, ms = 900) {
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(e) e.scrollTo({top:${top},behavior:'smooth'})})()`);
  await sleep(ms);
}
async function shot(name) {
  const hd = HD_NAMES[name];
  if (hd) await audit("still " + hd); // aborts a live take before an uncovered address could reach a still
  const r = hd
    ? await send("Page.captureScreenshot", { format: "jpeg", quality: 92, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })
    : await send("Page.captureScreenshot", { format: "jpeg", quality: 90, clip: { x: 0, y: 0, width: W, height: H - BAR, scale: 0.5 } });
  const file = hd ? join(HD_SHOTS, hd) : join(SHOTS, name);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  log("screenshot", file);
}
async function audit(where) {
  const s = await js(`(()=>({...window.__blurStats, visible:[...document.querySelectorAll('#__blur i')].filter(i=>i.getBoundingClientRect().width>1).length}))()`);
  const bad = s.leaks > 0 || (s.found > 0 && s.visible === 0);
  log(`blur audit (${where}): addresses ${s.found}, covers visible ${s.visible}, outside scanned areas ${s.leaks}${bad ? "  !! PROBLEM" : ""}`);
  if (bad && LIVE) throw new Error(`redaction audit failed at "${where}"; aborting the take so no address ends up in the video`);
  return s;
}
const mark = (name) => { marks[name] = frames.length; };
const redact = (t) => t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>");

/* terminal card */
const termShow = (html) => js(`(()=>{const t=document.getElementById('__term'); t.style.display='block'; t.querySelector('pre').innerHTML=${JSON.stringify(html)};})()`);
const termHide = () => js(`document.getElementById('__term').style.display='none'`);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function titleCard(on, html) {
  if (on) {
    await js(`(()=>{const c=document.getElementById('__card'); c.innerHTML=${JSON.stringify(html)}; c.style.display='flex'; requestAnimationFrame(()=>{c.style.opacity=1});})()`);
  } else {
    await js(`(()=>{const c=document.getElementById('__card'); c.style.opacity=0; setTimeout(()=>{c.style.display='none'},650)})()`);
  }
}

/* ───────────── operator pairing (LIVE only) ───────────── */

async function pairLive() {
  await send("Page.navigate", { url: `${APP}/operator` });
  await sleep(1500);
  const code = await js(`(document.querySelector('.code')||{}).textContent||''`);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error("no pairing code on /operator (already live, or operator mode off?)");
  log("pairing code shown on /operator; posting the token from the terminal");
  // The README's pairing command: the token is read from .env inside the command and is never printed.
  const cmd = `TOK="$(awk -F= '/^PACELINE_OPERATOR_TOKEN=/{print substr($0,index($0,"=")+1)}' .env)" && ` +
    `curl -s -o /dev/null -w '%{http_code}\\n' -X POST -H 'origin: ${PUBLIC}' ` +
    `--data-urlencode "token=$TOK" --data-urlencode "code=$PAIRCODE" ${PUBLIC}/operator; unset TOK`;
  const out = execFileSync("/bin/sh", ["-c", cmd], { cwd: ROOT, env: { ...process.env, PAIRCODE: code }, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  log("pairing HTTP", out);
  if (out !== "200") throw new Error("pairing failed with HTTP " + out);
  await send("Page.navigate", { url: `${APP}/operator` });
  await sleep(1200);
  const text = await js("document.body.innerText");
  if (!/live\s+PayPal sandbox/i.test(text)) throw new Error("operator page does not say the workspace is live after pairing");
  log("browser is paired with a live sandbox workspace");
}

async function backToSimulator() {
  await send("Page.navigate", { url: `${APP}/operator` });
  await sleep(1200);
  const live = await js(`!!document.querySelector('form input[value="lock"]')`);
  if (!live) { log("operator page: already on the simulator"); return; }
  await js(`document.querySelector('form input[value="lock"]').form.requestSubmit()`);
  await sleep(1800);
  await send("Page.navigate", { url: `${APP}/operator` });
  await sleep(1000);
  const still = await js(`!!document.querySelector('form input[value="lock"]')`);
  log(still ? "!! operator page still live" : "operator: back on the simulator");
  if (still) throw new Error("could not switch back to the simulator");
}

/* ───────────── the take ───────────── */

async function mode() {
  return js(`(document.querySelector('.mode-chip')||{dataset:{}}).dataset.mode`);
}

async function main() {
  ws = new WebSocket(await connect());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === "Page.screencastFrame") {
      const { data, sessionId, metadata } = msg.params;
      send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (recording) {
        const file = join(framesDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
        writeFileSync(file, Buffer.from(data, "base64"));
        frames.push({ t: metadata.timestamp, file, speedup, cut: false });
      }
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await renderSprites();

  if (LIVE) await pairLive();
  await send("Page.navigate", { url: `${APP}/` });
  await waitFor(`!!document.querySelector('.mode-chip')`, 30000, "app header");
  await sleep(1200);
  const m0 = await mode();
  if (LIVE && m0 !== "sandbox") throw new Error("expected the live sandbox workspace, header says: " + m0);
  if (!LIVE && m0 !== "simulator") throw new Error("expected the simulator, header says: " + m0);
  await ensureOverlays();
  const styled = await js(`(()=>{const c=getComputedStyle(document.getElementById('__cap')), b=getComputedStyle(document.getElementById('__blur')); return c.position==='fixed' && b.position==='fixed' && c.backgroundColor!=='rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.app')).height!==''})()`);
  if (!styled) throw new Error("the overlay styles were not applied (CSP?); refusing to record without captions and redaction");
  await waitFor(`!!document.querySelector('.hero')`, 15000, "empty hero (a fresh workspace)");

  // Every frame (about 60 fps while something moves) at quality 90: smoother motion than every 2nd frame at 95.
  await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: CW, maxHeight: CH, everyNthFrame: 1 });
  recording = true;

  /* 0. title */
  mark("title");
  cursorVisible(false);
  await titleCard(true, `<h1>Paceline</h1><p>Milestone billing where <b>“invoice paid”</b> is a real dependency in the plan</p><small>Demo of the deployment at paceline.gotclass.xyz · ${LIVE ? "live PayPal sandbox" : "dry run, simulator"}</small>`);
  narrate("title");
  await sleep(3200);
  await narrDone();
  await titleCard(false);
  await sleep(300);
  cursorVisible(true);
  await sleep(600);

  /* 1. the live sandbox workspace */
  mark("workspace");
  await pointAt(`document.querySelector('.mode-chip')`, 900);
  await say(LIVE ? "Live sandbox workspace: every invoice created here is a real invoice in PayPal's sandbox" : "(dry run) simulator workspace", { tag: LIVE ? "Live" : "Dry run", ms: 3600, n: LIVE ? "workspace-live" : "workspace-dry" });
  await pointAt(`[...document.querySelectorAll('.footer span')].find(e=>e.textContent.startsWith('PayPal host'))`, 800);
  await say("Sandbox only: the PayPal host is pinned to api-m.sandbox.paypal.com", { ms: 2800, n: "sandbox-host" });

  /* 2. brief -> plan */
  mark("plan");
  await say("Paste a brief, or pick a sample. Paceline only uses figures that are written in it", { ms: 1500, n: "brief" });
  await clickEl(byText(".samples .chip", "Brand refresh"));
  await sleep(2400);
  await shot("a1-brief.jpg");
  await say("Propose a plan. Waiting time is sped up in this video", { ms: 1700, n: "propose" });
  const planClick = Date.now();
  await clickEl(byText("button", "Propose a plan"));
  await narrDone();
  speedup = 4;
  const modalAfter = await waitFor(`!!document.querySelector('.modal-head h2') && /^Review plan/.test(document.querySelector('.modal-head h2').textContent)`, 150000, "plan review modal");
  speedup = 1;
  log(`plan came back after ${((Date.now() - planClick) / 1000).toFixed(1)} s`);
  const footer = await js(`document.querySelector('.modal-foot').textContent`);
  const byModel = /Proposed by the model/.test(footer);
  const notice = await js(`(document.querySelector('.modal-body .notice')||{}).textContent||''`);
  const httpCode = (notice.match(/HTTP (\d{3})/) || [])[1];
  log(`plan drafted by: ${byModel ? "the model (Nemotron)" : "the rule-based planner"}${httpCode ? ", provider answered HTTP " + httpCode : ""} | notice: ${notice.slice(0, 160)}`);
  if (process.env.REQUIRE_MODEL && !byModel) throw new Error("REQUIRE_MODEL: the plan did not come from the model: " + notice.slice(0, 160));
  await sleep(700);
  if (byModel) {
    await say("Nemotron (via Nebius) drafted this plan. The wait was sped up", { ms: 3000, n: "plan-model" });
  } else {
    await pointAt(`document.querySelector('.modal-body .notice')`, 800);
    await say(`Nemotron is unavailable right now${httpCode ? ` (Nebius returned HTTP ${httpCode})` : ""}, so the built-in rule-based planner drafted this plan. The app says so`, { ms: 6200, n: "plan-fallback" });
  }
  await say("The plan is checked against the brief before it is shown. Nothing has gone to PayPal yet", { ms: 3600, n: "plan-checked" });
  await shot("a2-plan-review.jpg");
  await pointAt(`document.querySelector('.ms-table select')`, 800);
  await say("Each milestone has a gate: it starts when the previous invoice is paid (or the previous work is delivered)", { ms: 4600, n: "gates" });
  await narrDone();
  await clickEl(byText(".modal-foot button", "Approve plan"));

  /* 3. the approval gate */
  mark("gate");
  await waitFor(`!document.querySelector('.modal-head h2') && !!document.querySelector('.proposal[data-kind="issue_invoice"]')`, 30000, "invoice proposal");
  await sleep(1000);
  const blocked = await pointAt(byText(".b-grid-cell, .pill", "Blocked", true), 900);
  await say("Plan approved. The second milestone is Blocked: it waits for the deposit invoice to be paid", { ms: 4200, n: "blocked" });
  await pointAt(`document.querySelector('.proposal .calls')`, 900);
  await say("The agent proposes the deposit invoice and lists the exact PayPal calls. Nothing is sent until you approve", { ms: 4800, n: "proposal" });
  if (process.env.BLUR_TEST) {
    // Test only: put a non-brief address into the card and check that it is covered.
    await js(`(()=>{const dd=[...document.querySelectorAll('.proposal .facts dd')].find(e=>/@/.test(e.textContent)); dd.textContent='sb-buyer8841@personal.example.com'; })()`);
    await sleep(500);
    await shot("blur-test.jpg");
    log("blur test stats", JSON.stringify(await js("window.__blurStats")));
  }
  await audit("approval card");
  await shot("a3-approval-gate.jpg");
  await narrDone();
  await clickEl(byText(".proposal-actions button", "Approve & send invoice"));
  await say(LIVE ? "Approved: create_invoice and send_invoice run against api-m.sandbox.paypal.com" : "Approved: create_invoice and send_invoice (simulated)", { ms: 1800, n: LIVE ? "approved-live" : "approved-dry" });
  await waitFor(`[...document.querySelectorAll('.pl-grid .ag-cell[col-id="number"]')].some(c=>/^[A-Z0-9]+-[A-Z0-9]+-\\d+$/.test(c.textContent.trim()))`, 90000, "invoice number in the ledger");
  invoiceNo = await js(`[...document.querySelectorAll('.pl-grid .ag-cell[col-id="number"]')].map(c=>c.textContent.trim()).find(t=>/^[A-Z0-9]+-[A-Z0-9]+-\\d+$/.test(t))`);
  log("invoice number", invoiceNo);
  await pointAt(`[...document.querySelectorAll('.pl-grid .ag-cell[col-id="number"]')].find(c=>c.textContent.trim()===${JSON.stringify(invoiceNo)})`, 900);
  await say(`The ledger row gets its number, ${invoiceNo}, with status Awaiting`, { ms: 3800, n: "ledger-row" });
  await audit("after invoice sent");
  await shot("a4-invoice-sent.jpg");

  /* 4. the payment */
  mark("payment");
  if (LIVE) {
    if (!/^PL-[A-Z0-9]{2,12}-\d{3,6}$/.test(invoiceNo)) throw new Error("unexpected invoice number: " + invoiceNo);
    const capText = "The client pays. For this recording the payment is recorded through PayPal's sandbox Invoicing API; PayPal sends the same INVOICING.INVOICE.PAID webhook.";
    await narrDone();
    await caption(capText);
    narrate("payment-live");
    const capStart = Date.now();
    const cmdLine = `npx tsx --env-file=.env scripts/try-sandbox.ts record-payment ${invoiceNo}`;
    const shown = [];
    const render = (running) => termShow(`<span class="d">$</span> ${esc(cmdLine)}\n${shown.map((l) => esc(l)).join("\n")}${running ? '\n<span class="blink"></span>' : ""}`);
    await render(true);
    const child = spawn("npx", ["tsx", "--env-file=.env", "scripts/try-sandbox.ts", "record-payment", invoiceNo], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.stderr.on("data", (d) => { buf += d.toString(); });
    const code = await new Promise((r) => child.on("close", r));
    for (const line of buf.split("\n")) {
      const t = redact(line.trim());
      if (/^(PL-|record payment:|invoice status now:)/.test(t)) shown.push(t.length > 110 ? t.slice(0, 107) + "..." : t);
    }
    log("record-payment exit", code, "|", shown.join(" | "));
    if (code !== 0 || !shown.some((l) => /MARKED_AS_PAID/.test(l))) { await render(false); throw new Error("record-payment did not end MARKED_AS_PAID (exit " + code + ")"); }
    await render(false);
    await sleep(2600);
    const left = 8000 - (Date.now() - capStart); // the caption needs about 8 s to read
    if (left > 0) await sleep(left);
    await narrDone();
    await termHide();
    await sleep(500);
  } else {
    await say("(dry run) the simulator's buyer pays; PayPal's real webhook is only used in the live take", { ms: 2500, n: "payment-dry" });
    await clickEl(byText(".pl-row-actions button", "Pay as buyer"));
  }
  mark("webhook");
  const paidExpr = `[...document.querySelectorAll('.pl-grid .pill')].some(e=>/^Paid/.test(e.textContent.trim()))`;
  if (await js(paidExpr)) await say("PayPal's webhook has already arrived", { ms: 1500, n: "webhook-arrived" });
  else await say("Waiting for PayPal's webhook to arrive (sped up)", { ms: 1500, n: "webhook-wait" });
  await narrDone();
  speedup = 8;
  const t0 = Date.now();
  await waitFor(`[...document.querySelectorAll('.pl-grid .pill')].some(e=>/^Paid/.test(e.textContent.trim()))`, 330000, "invoice Paid in the ledger");
  speedup = 1;
  log(`paid after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await sleep(900);

  /* 5. what Paceline does with the webhook */
  mark("unlock");
  await pointAt(`document.querySelector('.log li')`, 900);
  await say("The webhook is verified, the invoice is re-read from PayPal, and the plan is recomputed", { ms: 4600, n: "verified" });
  await audit("action log");
  await pointAt(byText(".b-grid-cell, .pill", "Scheduled", true), 800);
  await say("The deposit is Paid. The next milestone goes from Blocked to Scheduled", { ms: 4200, n: "unlocked" });
  await pointAt(`document.querySelector('.explain')`, 800);
  const tmpl = await js(`/Template/.test((document.querySelector('.explain .explain-meta')||{}).textContent||'')`);
  await say(tmpl ? "The agent explains the new delivery date, in template text built from PayPal and plan data (the model is unavailable)" : "The agent explains the new delivery date. Every figure is checked against PayPal and plan data", { ms: tmpl ? 6200 : 5200, n: tmpl ? "explain-template" : "explain-model" });
  await pointAt(`document.querySelector('.kpi[data-tone="paid"]')`, 700);
  await shot("a5-webhook-unlock.jpg");

  /* 6. Gantt and ledger tour */
  mark("tour");
  await pointAt(`document.querySelector('.plan-card .b-gantt, .plan-card')`, 700);
  await say("Bryntum Gantt: each milestone is a work bar and an invoice bar, joined by dependency lines", { ms: 3800, n: "gantt" });
  await narrDone();
  await clickEl(byText(".zoom button", "Fit"));
  await say("The paid gate is a real dependency: dashed while the invoice is open, green once PayPal confirms", { ms: 4200, n: "paid-gate" });
  await narrDone();
  await clickEl(byText(".chips .chip", "paid this month"));
  await sleep(500);
  await say("AG Grid ledger: ask in plain language. The words become a validated filter", { ms: 3800, n: "ledger-ask" });
  await shot("a6-ledger-query.jpg");
  await narrDone();
  await clickEl(byText(".answer button", "Clear"));
  await sleep(500);

  /* 7. simulator: overdue reschedule and reminder */
  mark("simulator");
  await narrDone();
  recording = false;
  if (frames.length) frames[frames.length - 1].cut = true;
  if (LIVE) await backToSimulator();
  await send("Page.navigate", { url: `${APP}/` });
  await waitFor(`!!document.querySelector('.mode-chip')`, 30000, "app header");
  await sleep(900);
  await ensureOverlays();
  if (LIVE) {
    const mm = await mode();
    if (mm !== "simulator") throw new Error("expected the simulator after Back to the simulator, header says: " + mm);
  } else {
    await clickEl(`document.querySelector('button[aria-label="Reset workspace"]')`);
    await clickEl(byText(".modal-foot button", "Reset"));
  }
  await waitFor(`!!document.querySelector('.hero')`, 15000, "empty hero");
  recording = true;
  await sleep(300);
  await say("Now the simulator, which is what public visitors get: a sample workspace with a late invoice", { tag: "Simulator", ms: 3800, n: "simulator" });
  await narrDone();
  await clickEl(byText("button", "Load sample workspace"));
  await waitFor(`!!document.querySelector('.kpis') && document.querySelector('.pl-grid .ag-row')`, 30000, "sample workspace");
  await sleep(1200);
  await say("An invoice is overdue. Everything gated on it slides, and the project shows how far it is behind plan", { tag: "Simulator", ms: 5200, n: "overdue" });
  await pointAt(`document.querySelector('.kpi[data-tone="late"]')`, 800);
  const hasDraft = await js(`!!document.querySelector('.proposal[data-kind="send_reminder"]')`);
  if (!hasDraft) HD_NAMES["b1-overdue.jpg"] = "06-overdue-reschedule-and-reminder.jpg";
  await shot("b1-overdue.jpg");
  if (hasDraft) {
    await pointAt(`document.querySelector('.proposal[data-kind="send_reminder"]')`, 900);
    await say("The agent drafts a reminder for you to edit and approve. Nothing is sent without your click", { tag: "Simulator", ms: 5000, n: "reminder" });
    await shot("b1b-reminder-draft.jpg");
    await narrDone();
    await clickEl(byText(".proposal[data-kind=\"send_reminder\"] .proposal-actions button", "Approve & send reminder"));
    await say("Approved in the simulator: no email is sent", { tag: "Simulator", ms: 2800, n: "reminder-approved" });
    await narrDone();
  }
  await clickEl(byText(".chips .chip", "group by client"));
  await waitFor(`!!document.querySelector('.answer')`, 20000, "group-by-client answer (server reachable?)");
  await sleep(600);
  await js(`(()=>{const v=document.querySelector('.pl-grid .ag-body-viewport'); if(v) v.scrollTo({top:9999,behavior:'smooth'})})()`);
  await say("AG Grid row grouping: group by client, with totals", { tag: "Simulator", ms: 3800, n: "group" });
  await shot("b2-group-by-client.jpg");
  await narrDone();
  await clickEl(byText(".answer button", "Clear"));

  /* outro */
  mark("outro");
  await caption("");
  cursorVisible(false);
  await titleCard(true, `<h1>Paceline</h1><p>The plan moves when PayPal says the money moved</p><small>paceline.gotclass.xyz · simulator for everyone, live PayPal sandbox for the operator</small>`);
  narrate("outro");
  await sleep(3800);
  await narrDone();
  await sleep(300);
  mark("end");
  recording = false;
  await send("Page.stopScreencast");
}

/* ───────────── assemble ───────────── */

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2); // ease in and out (cubic)

function assemble() {
  const kept = [];
  const at = []; // video time of each frame index
  const durs = [];
  let t = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], next = frames[i + 1];
    let dur = !next || f.cut ? 0.35 : (next.t - f.t) / f.speedup;
    dur = Math.min(Math.max(dur, 0.001), 12);
    at.push(t);
    durs.push(dur);
    t += dur;
    if (dur < 0.012 && kept.length) kept[kept.length - 1].dur += dur;
    else kept.push({ file: f.file, dur });
  }
  const lines = kept.map((k) => `file '${k.file}'\nduration ${k.dur.toFixed(4)}`);
  lines.push(`file '${kept[kept.length - 1].file}'`);
  const concat = join(work, "frames.txt");
  writeFileSync(concat, lines.join("\n") + "\n");
  // wall-clock seconds -> video seconds (speed-ups compressed; time inside a cut collapses onto the cut)
  const toVideo = (T) => {
    let lo = 0, hi = frames.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (frames[mid].t <= T) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return 0;
    return at[i] + Math.min(Math.max(T - frames[i].t, 0) / frames[i].speedup, durs[i]);
  };
  const nFrames = Math.round(t * FPS) + FPS;

  /* cursor track, one entry per output frame: sprite + top-left position in video px */
  const ev = cursorEv.map((e) => ({ ...e, v: toVideo(e.T), v1: e.type === "move" ? toVideo(e.T + e.dur) : 0 }));
  const track = [];
  let x = cur.x, y = cur.y, vis = false, mv = null, click = null, j = 0, clicks = 0, moves = 0;
  if (ev.length) { const firstMove = ev.find((e) => e.type === "move"); if (firstMove) { x = firstMove.x0; y = firstMove.y0; } }
  for (let i = 0; i < nFrames; i++) {
    const v = i / FPS;
    while (j < ev.length && ev[j].v <= v) {
      const e = ev[j++];
      if (e.type === "vis") vis = e.on;
      else if (e.type === "move") { mv = e; moves++; }
      else if (e.type === "click") { click = e; clicks++; }
    }
    if (mv) {
      const u = mv.v1 > mv.v ? Math.min(1, (v - mv.v) / (mv.v1 - mv.v)) : 1;
      x = mv.x0 + (mv.x1 - mv.x0) * ease(u);
      y = mv.y0 + (mv.y1 - mv.y0) * ease(u);
    }
    let sprite = "cur";
    if (click) { const k = Math.floor((v - click.v) * FPS + 1e-6); if (k >= 0 && k < PULSE_FRAMES) sprite = `p${k}`; }
    track.push({ sprite, x: vis ? Math.round(x * DPR) - ANCHOR * DPR : -1000, y: vis ? Math.round(y * DPR) - ANCHOR * DPR : -1000 });
  }
  // The sprite (arrow, or arrow + pulse stage) per frame: an image sequence, matched to the video by timestamp.
  const seq = join(work, "cursor-seq");
  rmSync(seq, { recursive: true, force: true });
  mkdirSync(seq);
  track.forEach((f, i) => symlinkSync(join(spritesDir, `${f.sprite}.png`), join(seq, `c${String(i).padStart(6, "0")}.png`)));
  // The position as overlay expressions of the frame time t (exact per frame, unlike sendcmd, which runs ahead of
  // the overlay's frame queue): start + sum over glides of delta * ease(progress), hidden outside the visible windows.
  const f4 = (n) => (Math.round(n * 10000) / 10000).toString();
  const glides = ev.filter((e) => e.type === "move" && (e.x1 !== e.x0 || e.y1 !== e.y0));
  const start = glides.length ? { x: glides[0].x0, y: glides[0].y0 } : { x: cur.x, y: cur.y };
  const axis = (a, a0) => [f4(a0 * DPR - ANCHOR * DPR), ...glides.map((g) => {
    const d = f4((g[a + "1"] - g[a + "0"]) * DPR), span = g.v1 - g.v;
    if (!(span > 0.001)) return `${d}*gte(t,${f4(g.v)})`;
    return `${d}*if(lt(st(0,clip((t-${f4(g.v)})/${f4(span)},0,1)),0.5),4*ld(0)*ld(0)*ld(0),1-pow(2-2*ld(0),3)/2)`;
  })].join("+");
  const windows = [];
  for (const e of ev.filter((e) => e.type === "vis")) {
    if (e.on && (!windows.length || windows[windows.length - 1].off !== undefined)) windows.push({ on: e.v });
    else if (!e.on && windows.length && windows[windows.length - 1].off === undefined) windows[windows.length - 1].off = e.v;
  }
  const visible = windows.map((w) => `gte(t,${f4(w.on)})*lt(t,${f4(w.off ?? 1e6)})`).join("+") || "0";
  const exprX = `if(${visible},${axis("x", start.x)},-1000)`, exprY = `if(${visible},${axis("y", start.y)},-1000)`;
  log(`cursor: ${moves} glides, ${clicks} clicks, ${windows.length} visible window(s), ${nFrames} frames`);

  /* narration track: clips placed at their scene's video time, mixed, then loudness-normalised (two passes) */
  let voice = null;
  const items = narrEv.map((e) => ({ key: e.key, v: toVideo(e.T) + 0.12, ...CLIPS[e.key] })).sort((a, b) => a.v - b.v);
  if (items.length) {
    for (let k = 1; k < items.length; k++) {
      const gap = items[k].v - (items[k - 1].v + items[k - 1].dur);
      if (gap < 0) throw new Error(`narration overlap: ${items[k - 1].key} -> ${items[k].key} by ${(-gap).toFixed(2)} s`);
    }
    const last = items[items.length - 1];
    if (last.v + last.dur > t) throw new Error(`narration runs ${(last.v + last.dur - t).toFixed(2)} s past the end`);
    const raw = join(work, "narration-raw.wav");
    const args = [...FF, "-f", "lavfi", "-t", t.toFixed(3), "-i", "anullsrc=r=48000:cl=mono"];
    items.forEach((it) => args.push("-i", it.file));
    const parts = items.map((it, k) => `[${k + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=${Math.round(it.v * 1000)}:all=1[a${k}]`);
    parts.push(`[0:a]${items.map((_, k) => `[a${k}]`).join("")}amix=inputs=${items.length + 1}:normalize=0:duration=first[m]`);
    execFileSync("nice", [...args, "-filter_complex", parts.join(";"), "-map", "[m]", "-c:a", "pcm_s16le", raw]);
    const target = "I=-16:TP=-1.5:LRA=11";
    const m1 = spawnSync("nice", ["-n", "10", "ffmpeg", "-hide_banner", "-nostats", "-threads", "2", "-i", raw, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
    const js1 = JSON.parse(m1.stderr.slice(m1.stderr.lastIndexOf("{"), m1.stderr.lastIndexOf("}") + 1));
    voice = join(work, "narration.wav");
    execFileSync("nice", [...FF, "-i", raw, "-af",
      `loudnorm=${target}:measured_I=${js1.input_i}:measured_TP=${js1.input_tp}:measured_LRA=${js1.input_lra}:measured_thresh=${js1.input_thresh}:offset=${js1.target_offset}:linear=true,aresample=48000`,
      "-c:a", "pcm_s16le", voice]);
    log(`narration: ${items.length} clips (${items.map((i) => i.key).join(", ")}); measured ${js1.input_i} LUFS -> -16`);
  }

  const hd = join(OUT, "demo-hd.mp4");
  const mp4 = join(OUT, "demo.mp4");
  const gif = join(OUT, "demo.gif");
  // One encode at a time, niced, 2 threads (the Mac is shared with other jobs).
  log(`encoding ${hd} (${CW}x${CH}, crf 17, cursor overlay${voice ? ", voice" : ""})`);
  const graph = `[0:v]fps=${FPS},scale=${CW}:${CH}:flags=lanczos:in_range=full:out_range=limited,format=yuv420p[b];` +
    `[1:v]format=rgba[s];[b][s]overlay=x='${exprX}':y='${exprY}':eval=frame:format=yuv420:eof_action=pass,format=yuv420p[v]`;
  writeFileSync(join(work, "filter.txt"), graph + "\n");
  execFileSync("nice", [...FF, "-f", "concat", "-safe", "0", "-i", concat, "-framerate", String(FPS), "-i", join(seq, "c%06d.png"),
    ...(voice ? ["-i", voice] : []), "-filter_complex", graph, "-map", "[v]", ...(voice ? ["-map", "2:a", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] : []),
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", ...COLOR, "-r", String(FPS), "-t", t.toFixed(3), "-threads", "2", "-movflags", "+faststart", hd]);
  log(`encoding ${mp4} (${W}x${H}, crf 20, from the HD master)`);
  execFileSync("nice", [...FF, "-i", hd, "-vf", `scale=${W}:${H}:flags=lanczos`, "-c:v", "libx264", "-preset", "slow", "-crf", "20", ...COLOR,
    "-threads", "2", ...(voice ? ["-c:a", "copy"] : []), "-movflags", "+faststart", mp4]);
  // GIF: the payment moment (webhook wait to the Gantt tour), 960 px wide.
  const g0 = at[marks.webhook] ?? 0, g1 = at[marks.tour] ?? t;
  execFileSync("nice", [...FF, "-ss", g0.toFixed(2), "-t", Math.min(g1 - g0, 24).toFixed(2), "-i", mp4, "-an",
    "-vf", "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", gif]);
  // Devpost thumbnail (3:2): the webhook-unlock still, padded with white above the header to 2880x1920.
  const s18 = join(HD_SHOTS, HD_NAMES["a5-webhook-unlock.jpg"]);
  if (existsSync(s18)) {
    execFileSync("nice", [...FF, "-i", s18, "-vf", `pad=${CW}:${CW * 2 / 3}:0:${CW * 2 / 3 - CH}:white`, "-q:v", "3", join(HD_SHOTS, "thumb-3x2.jpg")]);
  }
  const where = Object.entries(marks).map(([k, i]) => `${k} ${(at[i] ?? t).toFixed(1)}s`).join(", ");
  log(`frames ${frames.length}, video ${t.toFixed(1)} s ->`, hd, mp4, gif);
  log("scenes:", where);
  return t;
}

let failed = false, captured = false, keep = process.env.KEEP_WORK === "1";
const takeFile = join(work, "take.json");
if (ASSEMBLE_ONLY) {
  const take = JSON.parse(readFileSync(takeFile, "utf8"));
  frames.push(...take.frames); Object.assign(marks, take.marks); cursorEv.push(...take.cursorEv); narrEv.push(...take.narrEv);
  CLIPS = take.clips; invoiceNo = take.invoiceNo;
  captured = true; keep = true;
  log(`assembling the kept take in ${work} (${frames.length} frames, invoice ${invoiceNo})`);
} else {
  startChrome();
  try {
    await main();
    captured = true;
    writeFileSync(takeFile, JSON.stringify({ frames, marks, cursorEv, narrEv, clips: CLIPS, invoiceNo }));
  } catch (e) {
    failed = true;
    console.error("FAILED:", e.stack || e.message);
    process.exitCode = 1;
  }
  // Close the browser (back on the simulator first) before the long encode.
  if (LIVE) {
    try { recording = false; await backToSimulator(); } catch (e) { console.error("cleanup (back to the simulator) failed:", e.message); process.exitCode = 1; }
  }
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  await sleep(300);
}
try {
  if (captured) assemble();
} catch (e) {
  failed = true;
  if (captured) keep = true; // the frames are kept so the assembly can be re-run with ASSEMBLE_ONLY
  console.error("FAILED (encode):", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (keep && captured) log("take kept for ASSEMBLE_ONLY in", work);
  else rmSync(work, { recursive: true, force: true });
  if (failed) log(captured ? "encode failed: re-run with ASSEMBLE_ONLY=" + work : "failed take: no video written");
}
