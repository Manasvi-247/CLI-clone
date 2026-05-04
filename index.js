import "dotenv/config";
import { OpenAI } from "openai";
import { chromium } from "playwright";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import readline from "readline/promises";
import axios from "axios";

const COLORS = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m",
  magenta: "\x1b[35m", red: "\x1b[31m", blue: "\x1b[34m",
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

let browser = null;
let page = null;

async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  if (!page) page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
}

async function openPage(args) {
  const { url } = parseArgs(args);
  await ensureBrowser();
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  const title = await page.title();
  return `Opened "${title}" at ${url}`;
}

async function listSelectors() {
  if (!page) return "No page open. Call openPage first.";
  const counts = await page.evaluate(() => {
    const sels = ["header", "nav", "main", "footer", "section", "article",
                  ".hero", "[class*=hero]", "[class*=header]", "[class*=footer]",
                  "[class*=nav]", "[class*=feature]", "[class*=card]",
                  "h1", "h2", "h3", "button", "a", "img"];
    const out = {};
    for (const s of sels) {
      try { out[s] = document.querySelectorAll(s).length; } catch {}
    }
    return out;
  });
  return JSON.stringify(counts);
}

async function extractText(args) {
  const { selector } = parseArgs(args);
  if (!page) return "No page open.";
  const text = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.slice(0, 3000) : null;
  }, selector);
  return text === null ? `No element matched ${selector}` : text;
}

async function extractStyles(args) {
  const { selector } = parseArgs(args);
  if (!page) return "No page open.";
  const styles = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const props = ["color", "background-color", "background-image",
                   "font-family", "font-size", "font-weight",
                   "padding", "margin", "border-radius",
                   "display", "flex-direction", "justify-content", "align-items",
                   "width", "max-width"];
    return Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]));
  }, selector);
  return styles === null ? `No element matched ${selector}` : JSON.stringify(styles);
}

async function extractHTML(args) {
  const { selector, maxLen = 2000 } = parseArgs(args);
  if (!page) return "No page open.";
  const html = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.outerHTML : null;
  }, selector);
  if (html === null) return `No element matched ${selector}`;
  return html.length > maxLen ? html.slice(0, maxLen) + "\n...[truncated]" : html;
}

async function installBackground(args) {
  const { folder } = parseArgs(args);
  if (!folder) return "ERROR: missing 'folder' argument.";
  const src = path.resolve(process.cwd(), "image.png");
  const destDir = path.resolve(process.cwd(), folder, "assets");
  const dest = path.join(destDir, "bg.png");
  try {
    await fs.access(src);
  } catch {
    return `ERROR: source background not found at ${src}`;
  }
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(src, dest);
  return `Installed background at ${path.relative(process.cwd(), dest)}. Reference it in CSS as url('./assets/bg.png').`;
}

async function extractBackgroundLayers() {
  if (!page) return "No page open.";
  const data = await page.evaluate(() => {
    const root = document.querySelector("body > div") || document.body;
    const rootBg = getComputedStyle(root).backgroundColor;
    const layers = [];
    const all = document.querySelectorAll("body div");
    for (const el of all) {
      if (layers.length >= 12) break;
      const inline = el.getAttribute("style") || "";
      if (!/background(?:-image)?\s*:/i.test(inline)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed") continue;
      layers.push({
        inlineStyle: inline.slice(0, 600),
        rect: { top: cs.top, left: cs.left, right: cs.right, bottom: cs.bottom, width: cs.width, height: cs.height },
        zIndex: cs.zIndex,
      });
    }
    return { rootBackgroundColor: rootBg, layers };
  });
  return JSON.stringify(data);
}

async function extractAllSections() {
  if (!page) return "No page open.";
  const data = await page.evaluate(() => {
    const pick = (cs, p) => cs.getPropertyValue(p);
    const summarize = (el) => {
      const cs = getComputedStyle(el);
      const heading = el.querySelector("h1,h2,h3")?.innerText || "";
      const images = [...el.querySelectorAll("img")].slice(0, 4).map(img => ({
        src: img.currentSrc || img.src, alt: img.alt,
      }));
      const cta = [...el.querySelectorAll("button, a.btn, [role=button], a[href]")].slice(0, 4)
        .map(b => b.innerText.trim()).filter(Boolean);
      return {
        heading,
        text: (el.innerText || "").slice(0, 1500),
        ctas: cta,
        images,
        styles: {
          color: pick(cs, "color"),
          backgroundColor: pick(cs, "background-color"),
          backgroundImage: pick(cs, "background-image"),
          padding: pick(cs, "padding"),
          fontFamily: pick(cs, "font-family"),
          fontSize: pick(cs, "font-size"),
        },
      };
    };
    const out = { header: null, hero: null, sections: [], footer: null };
    const header = document.querySelector("header") || document.querySelector("nav");
    if (header) out.header = summarize(header);
    const sections = [...document.querySelectorAll("section")];
    sections.forEach((el, i) => {
      const s = summarize(el);
      s.index = i + 1;
      if (i === 0 && (el.querySelector("h1") || s.heading.length > 0)) out.hero = s;
      else out.sections.push(s);
    });
    const footer = document.querySelector("footer");
    if (footer) out.footer = summarize(footer);
    return out;
  });
  return JSON.stringify(data);
}

async function listImages(args) {
  const { selector = "body", limit = 10 } = parseArgs(args || {});
  if (!page) return "No page open.";
  const imgs = await page.evaluate(({ sel, lim }) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    return [...root.querySelectorAll("img")]
      .slice(0, lim)
      .map(i => ({ src: i.currentSrc || i.src, alt: i.alt, w: i.naturalWidth, h: i.naturalHeight }));
  }, { sel: selector, lim: limit });
  return JSON.stringify(imgs);
}

async function downloadImage(args) {
  const { url, savePath } = parseArgs(args);
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  await fs.writeFile(savePath, resp.data);
  return `Downloaded ${resp.data.byteLength} bytes to ${savePath}`;
}

async function screenshot(args) {
  const { savePath, fullPage = true } = parseArgs(args);
  if (!page) return "No page open.";
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await page.screenshot({ path: savePath, fullPage });
  return `Screenshot saved to ${savePath}`;
}

async function writeFile(args) {
  const { path: filePath, content } = parseArgs(args);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return `Wrote ${content.length} chars to ${filePath}`;
}

async function executeCommand(args) {
  const { cmd } = parseArgs(args);
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) return resolve(`ERROR: ${error.message}\n${stderr}`);
      resolve(stdout || stderr || "Command executed.");
    });
  });
}

async function closeBrowser() {
  if (page) { await page.close(); page = null; }
  if (browser) { await browser.close(); browser = null; }
  return "Browser closed.";
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed); } catch {}
    }
    return { value: args };
  }
  return {};
}

const tool_map = {
  openPage, listSelectors, extractText, extractStyles, extractHTML,
  extractAllSections, extractBackgroundLayers, installBackground,
  listImages, downloadImage, screenshot, writeFile, executeCommand, closeBrowser,
};

const tool_specs = `
Tools available:
1. openPage({ url }) — Launches a headless browser and navigates to the URL. Call once at the start.
2. listSelectors() — Returns a JSON object with counts of common selectors (header, nav, section, footer, h1, etc.). Use this to discover what exists.
3. extractText({ selector }) — Returns innerText (up to 3000 chars) of the first match. Use for individual elements.
4. extractStyles({ selector }) — Returns computed CSS (color, background, font, padding, etc.) for the first match.
5. extractHTML({ selector }) — Returns outerHTML (truncated). Use sparingly.
6. extractAllSections() — POWERFUL: returns header + hero + every body section + footer in ONE call. Each entry includes heading, full text (up to 1500 chars), CTA labels, images, and computed styles (color, background-color, background-image, padding, font-family, font-size). USE THIS instead of looping extractText/extractStyles for sections.
7. extractBackgroundLayers() — Returns the page's background composition. (Optional — generally prefer installBackground for the page bg.)
7b. installBackground({ folder }) — Copies the pre-prepared dark/glow background image (project-root image.png) into <folder>/assets/bg.png. After calling this, your CSS should set body { background: #09090b url('./assets/bg.png') center top / cover no-repeat fixed; }.
8. listImages({ selector, limit }) — Returns image src URLs found within the selector.
9. downloadImage({ url, savePath }) — Downloads an image to disk. Use to grab hero/feature images so the clone renders offline.
10. screenshot({ savePath, fullPage }) — Saves a page screenshot.
11. writeFile({ path, content }) — Creates a file (and parent dirs).
12. executeCommand({ cmd }) — Runs a shell command (mkdir, ls, open, etc.).
13. closeBrowser() — Closes the browser when done.
`;

const SYSTEM_PROMPT = `
You are a CLI coding agent that clones websites by inspecting them with a real browser and then writing original HTML/CSS/JS that reproduces the look and structure.

You operate in a strict loop using these step types: START, THINK, TOOL, OBSERVE, OUTPUT.

${tool_specs}

NON-NEGOTIABLE OUTPUT REQUIREMENTS:
The generated index.html MUST contain a working <header>, a working hero <section>, AND a working <footer>. A clone that omits any of these three is INVALID — keep iterating with TOOL steps until all three are present and styled. Do NOT call OUTPUT until header + hero + footer are all rendered with real content (not empty tags) and styled in styles.css.

Rules:
1. Respond with EXACTLY ONE JSON object per turn. No markdown fences, no extra text, no trailing JSON.
2. Output format: { "step": "START|THINK|TOOL|OUTPUT", "content": "string", "tool_name": "string (only for TOOL)", "tool_args": object (only for TOOL) }
3. NEVER produce an OBSERVE step yourself — that comes from the developer after every TOOL call.
4. Do at least one THINK step before each TOOL call.
5. Use real CSS values from extractStyles (colors, fonts, spacing) so the clone matches the source design.
6. For longer paragraph copy, write your own original marketing copy in the same voice — do not paste long verbatim text from the source. Short functional labels (nav items, button text, section headings) may be reused.
7. The final page must render correctly when opened directly from disk. Use absolute URLs for any remote images (e.g. https://example.com/img.png), or download them locally first with downloadImage.
8. Build the page with semantic HTML: <header>, <section class="hero">, multiple feature <section>s, <footer>. Link an external styles.css; do NOT inline all CSS.

Required workflow (DO NOT skip steps; the clone is incomplete without them):

PHASE 1 — RECON (do all of these before writing any file):
  a. openPage(url)
  b. screenshot to <folder>/reference.png  (full page reference for the user)
  c. listSelectors  (see how many <section>s exist — note this number, you must render every one)
  d. extractAllSections  (one call returns header + hero + ALL body sections + footer with their text, CTAs, images, and computed styles). YOU MUST RENDER EVERY BODY SECTION RETURNED — do not omit any.
  e. installBackground({ folder: "<folder>" })  (copies the pre-prepared dark glow background into <folder>/assets/bg.png; reference it in CSS as url('./assets/bg.png')).
  f. For EACH unique image URL surfaced by extractAllSections (hero/dashboard preview, feature illustrations, logos), call downloadImage and save to <folder>/assets/<name>.png. Reference these via relative paths "./assets/..." in HTML so the page works offline.

PHASE 2 — BUILD index.html (writeFile <folder>/index.html):
Semantic markup with these structural requirements:
  • <header> sticky/translucent: brand/logo on the left, primary CTA (e.g. "Sign In") on the right.
  • Hero <section>: small badge/eyebrow text, large <h1>, subhead <p>, TWO CTA <button>/<a class="btn">, and an <img> showing the page's hero/preview image (use a downloaded local asset path).
  • For EVERY body section returned by extractAllSections, generate one <section> with:
      - the section's <h2> heading from the extracted data,
      - a descriptive <p> in your own original voice,
      - if the section's text/CTAs/images suggest multiple repeating items (a feature grid), render a <div class="grid"> with at least 3 <article class="card"> children, each containing an <span class="icon"> placeholder, an <h3> title, and a 1-line <p>. Reuse short labels from extracted text where they fit; invent reasonable filler labels otherwise.
      - if the section is a "split" layout (text + cards/image), render a two-column row.
  • A final <section class="cta"> with a centered <h2> and one CTA button (mirrors the source's "Ready to get started?" section).
  • <footer> with at least 2 columns of links (Privacy / Terms / Data, or Product / Company / Resources) plus a copyright line.
  • <link rel="stylesheet" href="styles.css"> and <script defer src="script.js"></script> in <head>.
  • Length must exceed 5000 chars.

PHASE 2 — BUILD styles.css (writeFile <folder>/styles.css). Focus heavily on layout, spacing, and div placement:

REQUIRED RULES (every block below must appear in styles.css):

  /* Reset + base */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { min-height: 100%; }
  body {
    color: #ffffff;
    font-family: <fontFamily from extractAllSections, fallback to 'Inter', system-ui, sans-serif>;
    background: #09090b url('./assets/bg.png') center top / cover no-repeat fixed;
  }

  /* Page-width container — every section uses .container inside it */
  .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

  /* Sticky translucent header with backdrop blur */
  header { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(10px); background: rgba(9,9,11,0.7); border-bottom: 1px solid rgba(255,255,255,0.06); }
  header nav { display: flex; align-items: center; justify-content: space-between; height: 56px; }
  header .logo { font-weight: 600; font-size: 14px; }
  header .nav-ctas button { background: #fff; color: #000; padding: 6px 16px; border-radius: 6px; border: 0; font-weight: 500; cursor: pointer; }

  /* Hero */
  .hero { padding: 96px 24px 64px; text-align: center; }
  .hero h1 { font-size: clamp(36px, 6vw, 64px); font-weight: 700; line-height: 1.1; letter-spacing: -0.02em; margin-bottom: 16px; }
  .hero > p { color: rgba(255,255,255,0.6); font-size: 18px; max-width: 560px; margin: 0 auto 32px; }
  .hero-ctas { display: flex; gap: 12px; justify-content: center; margin-bottom: 48px; flex-wrap: wrap; }
  .hero-ctas button:first-child { background: #2563eb; color: #fff; padding: 10px 22px; border-radius: 8px; border: 0; font-weight: 500; cursor: pointer; }
  .hero-ctas button:last-child { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.15); padding: 10px 22px; border-radius: 8px; cursor: pointer; }
  .hero img { display: block; max-width: 1000px; width: 100%; margin: 0 auto; border-radius: 12px; box-shadow: 0 24px 80px rgba(0,0,0,0.6); }

  /* Body sections */
  section { padding: 80px 24px; border-top: 1px solid rgba(255,255,255,0.06); }
  section h2 { font-size: clamp(24px, 3vw, 36px); font-weight: 700; text-align: center; margin-bottom: 12px; }
  section > p { color: rgba(255,255,255,0.5); text-align: center; max-width: 560px; margin: 0 auto 40px; }

  /* Card grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1px; max-width: 1100px; margin: 0 auto; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; overflow: hidden; }
  .card { background: #0d0d10; padding: 24px; transition: background 200ms; }
  .card:hover { background: #131318; }
  .card .icon { display: inline-block; width: 32px; height: 32px; border-radius: 8px; background: rgba(37,99,235,0.15); margin-bottom: 12px; }
  .card h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .card p { font-size: 13px; color: rgba(255,255,255,0.5); line-height: 1.5; }

  /* Final CTA */
  .cta { text-align: center; padding: 96px 24px; }
  .cta h2 { margin-bottom: 24px; }
  .cta button { background: #2563eb; color: #fff; padding: 12px 28px; border-radius: 8px; border: 0; font-weight: 500; cursor: pointer; }

  /* Footer */
  footer { padding: 32px 24px; border-top: 1px solid rgba(255,255,255,0.06); }
  .footer-columns { display: flex; flex-wrap: wrap; gap: 32px; justify-content: space-between; max-width: 1100px; margin: 0 auto; align-items: center; }
  footer a { color: rgba(255,255,255,0.4); text-decoration: none; font-size: 12px; margin-right: 16px; }
  footer a:hover { color: rgba(255,255,255,0.7); }

  /* Responsive */
  @media (max-width: 768px) {
    .hero { padding: 80px 16px 40px; }
    section { padding: 56px 16px; }
    .footer-columns { flex-direction: column; align-items: flex-start; gap: 16px; }
  }

You MUST adapt these blocks but keep all the structural class names (.container, .hero, .hero-ctas, .grid, .card, .cta, .footer-columns) so the HTML class names match. styles.css must exceed 3500 chars after expansion.

PHASE 2 — BUILD script.js (writeFile <folder>/script.js):
  • Smooth scroll for in-page nav anchor links.
  • IntersectionObserver-based fade-in/slide-up on each <section>.
  • Sticky-header style change on scroll (e.g. add .scrolled class after 40px).

PHASE 3 — FINISH:
  • executeCommand "ls -la <folder>" to verify files exist.
  • closeBrowser.
  • OUTPUT with the path to <folder>/index.html and the suggestion to run "python3 -m http.server -d <folder> 8000" or just open the file.

Self-check before OUTPUT — if ANY answer is "no", do another TOOL step instead of OUTPUT:
  • header has logo+CTA, sticky styling in CSS?
  • hero has h1 + subhead + 2 CTAs + an <img> with src pointing to a downloaded asset?
  • The HTML has one <section> for EVERY body section returned by extractAllSections (count them — if extractAllSections returned N body sections, the HTML must contain N <section> tags between the hero and the final CTA)?
  • At least 2 body sections are rendered as card grids with ≥3 cards each?
  • Final CTA section + footer with ≥2 column groups present?
  • CSS uses real rgb() values from extracted styles, has grid + cards + buttons + @media?
  • CSS includes the page background: body has the rootBackgroundColor + ≥2 radial-gradient overlay layers (via ::before/::after or fixed divs) reproduced from extractBackgroundLayers?
  • script.js has smooth-scroll AND intersection-observer fade-in?
  • index.html > 5000 chars and styles.css > 3500 chars?
  • Ran ls -la and closeBrowser?

Example turn:
user: clone https://example.com into example_clone
assistant: { "step": "START", "content": "User wants me to clone example.com into the example_clone/ folder." }
assistant: { "step": "THINK", "content": "I will first open the page in a headless browser to inspect its structure." }
assistant: { "step": "TOOL", "tool_name": "openPage", "tool_args": { "url": "https://example.com" } }
developer: { "step": "OBSERVE", "content": "Opened \\"Example Domain\\" at https://example.com" }
assistant: { "step": "THINK", "content": "Now I'll list selectors to see what sections exist." }
... (continues)
assistant: { "step": "OUTPUT", "content": "Done. Open example_clone/index.html in your browser." }

Remember: ONE JSON object per turn, no fences, no commentary outside the JSON.
`.trim();

function safeParseJSON(text) {
  if (!text) throw new Error("Empty model response");
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON object in response");
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("Unbalanced JSON in response");
}

function formatToolArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.length > 80 ? args.slice(0, 80) + "..." : args;
  const json = JSON.stringify(args);
  return json.length > 80 ? json.slice(0, 80) + "..." : json;
}

class KeyPool {
  constructor(keys, baseURL) {
    this.clients = keys.map((apiKey) => ({
      client: new OpenAI({ apiKey, baseURL }),
      cooldownUntil: 0,
      label: apiKey.slice(-6),
    }));
    this.idx = 0;
  }
  get size() { return this.clients.length; }
  current() { return this.clients[this.idx]; }
  rotate(reason = "rotate") {
    const before = this.idx;
    for (let i = 1; i <= this.clients.length; i++) {
      const next = (before + i) % this.clients.length;
      if (this.clients[next].cooldownUntil <= Date.now()) {
        this.idx = next;
        if (next !== before) {
          console.log(c("dim", `  (switched to key ${next + 1}/${this.clients.length} [...${this.clients[next].label}] — ${reason})`));
        }
        return true;
      }
    }
    return false;
  }
  cooldown(seconds) {
    this.current().cooldownUntil = Date.now() + seconds * 1000;
  }
  earliestAvailable() {
    return Math.min(...this.clients.map(c => c.cooldownUntil));
  }
}

async function callLLMWithRotation(pool, model, messages) {
  const MAX_TOTAL_ATTEMPTS = pool.size * 4;
  let backoff = 8000;
  for (let attempt = 0; attempt < MAX_TOTAL_ATTEMPTS; attempt++) {
    const slot = pool.current();
    if (slot.cooldownUntil > Date.now()) {
      if (!pool.rotate("cooldown skip")) {
        const wait = Math.max(1000, pool.earliestAvailable() - Date.now());
        console.log(c("dim", `  (all keys cooling, sleeping ${Math.ceil(wait / 1000)}s)`));
        await new Promise(r => setTimeout(r, wait));
      }
      continue;
    }
    try {
      return await slot.client.chat.completions.create({
        model,
        messages,
        response_format: { type: "json_object" },
      });
    } catch (e) {
      const status = e.status || e.response?.status;
      const transient = status === 429 || status === 503 || status === 500;
      if (!transient) throw e;
      pool.cooldown(30);
      const rotated = pool.rotate(status === 503 ? "service busy" : "rate limit");
      if (!rotated) {
        console.log(c("dim", `  (all keys cooling, backing off ${backoff / 1000}s)`));
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }
  throw new Error("Exhausted all keys and retries");
}

async function runAgentLoop(pool, model, messages) {
  const MAX_ITERATIONS = 80;
  let lastCallAt = 0;
  const MIN_GAP_MS = 3000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const sinceLast = Date.now() - lastCallAt;
    if (sinceLast < MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS - sinceLast));
    }
    let response;
    try {
      response = await callLLMWithRotation(pool, model, messages);
      lastCallAt = Date.now();
    } catch (e) {
      console.log(c("red", `\n[API error] ${e.message}`));
      return;
    }

    const raw = response.choices[0]?.message?.content || "";
    let parsed;
    try {
      parsed = safeParseJSON(raw);
    } catch (e) {
      console.log(c("red", `\n[Parse error] ${e.message}\nRaw: ${raw.slice(0, 200)}`));
      messages.push({
        role: "user",
        content: `Your last response was not valid JSON. Reply with EXACTLY one JSON object matching the required format. Error: ${e.message}`,
      });
      continue;
    }

    messages.push({ role: "assistant", content: JSON.stringify(parsed) });

    const step = parsed.step;
    if (step === "START") {
      console.log(c("blue", `\n[START] `) + parsed.content);
    } else if (step === "THINK") {
      console.log(c("yellow", `[THINK] `) + parsed.content);
    } else if (step === "TOOL") {
      const name = parsed.tool_name;
      const args = parsed.tool_args;
      console.log(c("magenta", `[TOOL]  `) + `${name}(${formatToolArgs(args)})`);
      const fn = tool_map[name];
      let observeContent;
      if (!fn) {
        observeContent = `Tool "${name}" is not available. Available tools: ${Object.keys(tool_map).join(", ")}`;
      } else {
        try {
          const result = await fn(args);
          observeContent = typeof result === "string" ? result : JSON.stringify(result);
        } catch (e) {
          observeContent = `ERROR: ${e.message}`;
        }
      }
      const preview = observeContent.length > 200 ? observeContent.slice(0, 200) + "..." : observeContent;
      console.log(c("cyan", `[OBS]   `) + preview);
      messages.push({
        role: "user",
        content: JSON.stringify({ step: "OBSERVE", content: observeContent }),
      });
    } else if (step === "OBSERVE") {
      // Model echoed an observe — ignore and continue.
      continue;
    } else if (step === "OUTPUT") {
      console.log(c("green", `\n[OUTPUT] `) + parsed.content + "\n");
      return;
    } else {
      console.log(c("red", `[Unknown step] ${step}`));
      messages.push({
        role: "user",
        content: `Unknown step "${step}". Use START, THINK, TOOL, or OUTPUT.`,
      });
    }
  }
  console.log(c("red", `\n[Hit max iterations of ${MAX_ITERATIONS}]`));
}

function pickProvider() {
  const forced = (process.env.PROVIDER || "").toLowerCase();
  const cleanKeys = (raw) => (raw || "")
    .split(",").map(s => s.trim())
    .filter(k => k && !k.toLowerCase().includes("paste") && !k.toLowerCase().includes("your_") && !k.startsWith("key1") && !k.startsWith("key2") && !k.startsWith("key3"));

  const groqKeys = cleanKeys(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY);
  const geminiKeys = cleanKeys(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY);

  const useGroq = forced === "groq" || (forced !== "gemini" && groqKeys.length > 0);
  if (useGroq) {
    if (groqKeys.length === 0) throw new Error("PROVIDER=groq but no GROQ_API_KEY/S found");
    return { provider: "groq", keys: groqKeys, baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" };
  }
  if (geminiKeys.length === 0) throw new Error("No usable API keys found. Set GROQ_API_KEY or GEMINI_API_KEY in .env");
  return { provider: "gemini", keys: geminiKeys, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-2.5-flash" };
}

async function main() {
  let cfg;
  try { cfg = pickProvider(); } catch (e) {
    console.error(c("red", e.message));
    console.error(c("dim", "Groq: https://console.groq.com/keys   Gemini: https://aistudio.google.com/apikey"));
    process.exit(1);
  }

  const pool = new KeyPool(cfg.keys, cfg.baseURL);
  const model = process.env.MODEL || cfg.defaultModel;

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(c("bold", "\n  Website Clone Agent  "));
  console.log(c("dim", `  Provider: ${cfg.provider}   Model: ${model}   Keys: ${pool.size}`));
  console.log(c("dim", `  Type your instruction below. Type /exit to quit, /reset to clear history.\n`));
  console.log(c("dim", `  Example: clone https://sst-dashboard.com/ into sst_clone\n`));

  try {
    while (true) {
      const input = (await rl.question(c("bold", "you > "))).trim();
      if (!input) continue;
      if (input === "/exit") break;
      if (input === "/reset") {
        messages.length = 1;
        console.log(c("dim", "  (history cleared)\n"));
        continue;
      }
      messages.push({ role: "user", content: input });
      await runAgentLoop(pool, model, messages);
    }
  } finally {
    await closeBrowser().catch(() => {});
    rl.close();
  }
}

main().catch((e) => {
  console.error(c("red", `Fatal: ${e.message}`));
  process.exit(1);
});
