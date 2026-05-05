/**
 * Website Clone Agent — single-file CLI agent.
 *
 * Layout of this file:
 *   1. Imports + ANSI helpers
 *   2. Browser singletons + tool functions  (Playwright-backed scraping + fs/shell)
 *   3. tool_map + tool_specs               (registered tools, prompt-visible spec)
 *   4. SYSTEM_PROMPT                        (agent rules + Scaler design reference)
 *   5. JSON parser + KeyPool + LLM caller   (resilience: brace-balanced parse,
 *                                            multi-key rotation, retry/backoff)
 *   6. runAgentLoop                         (START/THINK/TOOL/OBSERVE/OUTPUT state machine)
 *   7. pickProvider + main                  (env config + readline interactive shell)
 *
 * Conversational memory: the `messages` array in main() persists across user
 * turns, so follow-ups like "make the hero text larger" reuse prior context.
 */

import "dotenv/config";
import { OpenAI } from "openai";
import { chromium } from "playwright";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import readline from "readline/promises";
import axios from "axios";

// ANSI color helpers for the colored [START]/[THINK]/[TOOL]/[OBS]/[OUTPUT] log prefixes.
const COLORS = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m",
  magenta: "\x1b[35m", red: "\x1b[31m", blue: "\x1b[34m",
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

// ============================================================================
// 2. BROWSER TOOLS — Playwright-backed scraping + small fs/shell helpers.
// Every function here is registered in tool_map and callable by the agent.
// All return strings (or stringifiable JSON); the runner stuffs the result
// into an OBSERVE message that the model sees on the next turn.
// ============================================================================

let browser = null;
let page = null;

/** Lazy-launch a single headless Chromium + page (1440x900 viewport). */
async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  if (!page) page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
}

/** Tool: navigate to a URL, waiting for networkidle. Returns the page title. */
async function openPage(args) {
  const { url } = parseArgs(args);
  await ensureBrowser();
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  const title = await page.title();
  return `Opened "${title}" at ${url}`;
}

/** Tool: count matches for a fixed list of common selectors — quick recon. */
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

/** Tool: innerText of the first selector match (truncated to 3000 chars). */
async function extractText(args) {
  const { selector } = parseArgs(args);
  if (!page) return "No page open.";
  const text = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.slice(0, 3000) : null;
  }, selector);
  return text === null ? `No element matched ${selector}` : text;
}

/** Tool: computed CSS for a selector (color, bg, font, padding, layout). */
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

/** Tool: outerHTML of a selector, truncated to maxLen (default 2000). */
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

/**
 * Tool: capture the page's layered glow background.
 * Many modern sites build their visual bg from absolute-positioned overlay divs
 * with inline radial-gradient styles (NOT a body background). This walks the DOM
 * and returns the first 12 such layers + the root container's background-color.
 */
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

/**
 * Tool: one-shot dump of header + hero + every body <section> + footer.
 * Returns each region's heading, truncated text, CTA labels, images, and
 * computed styles. Saves many round-trips vs looping extractText/extractStyles.
 */
async function extractAllSections() {
  if (!page) return "No page open.";
  const data = await page.evaluate(() => {
    const pick = (cs, p) => cs.getPropertyValue(p);
    const summarize = (el) => {
      const cs = getComputedStyle(el);
      const heading = (el.querySelector("h1,h2,h3")?.innerText || "").slice(0, 120);
      const images = [...el.querySelectorAll("img")].slice(0, 2).map(img => ({
        src: (img.currentSrc || img.src || "").slice(0, 200), alt: (img.alt || "").slice(0, 80),
      }));
      const cta = [...el.querySelectorAll("button, a.btn, [role=button]")].slice(0, 3)
        .map(b => b.innerText.trim().slice(0, 40)).filter(Boolean);
      return {
        heading,
        text: (el.innerText || "").slice(0, 500),
        ctas: cta,
        images,
        styles: {
          color: pick(cs, "color"),
          backgroundColor: pick(cs, "background-color"),
          fontFamily: pick(cs, "font-family").slice(0, 60),
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

/** Tool: list image src URLs found within a selector (default body, limit 10). */
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

/** Tool: download a remote image to disk via axios (creates parent dirs). */
async function downloadImage(args) {
  const { url, savePath } = parseArgs(args);
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  await fs.writeFile(savePath, resp.data);
  return `Downloaded ${resp.data.byteLength} bytes to ${savePath}`;
}

/** Tool: full-page or viewport screenshot to a file path. */
async function screenshot(args) {
  const { savePath, fullPage = true } = parseArgs(args);
  if (!page) return "No page open.";
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await page.screenshot({ path: savePath, fullPage });
  return `Screenshot saved to ${savePath}`;
}

/** Tool: write a file (creates parent dirs). Overwrites if it exists. */
async function writeFile(args) {
  const { path: filePath, content } = parseArgs(args);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return `Wrote ${content.length} chars to ${filePath}`;
}

/** Tool: read a file (truncated to maxLen). Used for follow-up edit flows. */
async function readFile(args) {
  const { path: filePath, maxLen = 20000 } = parseArgs(args);
  if (!filePath) return "ERROR: missing 'path' argument.";
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return text.length > maxLen ? text.slice(0, maxLen) + "\n...[truncated]" : text;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

/** Tool: run a shell command with a 30s timeout; returns stdout or ERROR. */
async function executeCommand(args) {
  const { cmd } = parseArgs(args);
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) return resolve(`ERROR: ${error.message}\n${stderr}`);
      resolve(stdout || stderr || "Command executed.");
    });
  });
}

/** Tool: close the page + browser singletons. Always call before OUTPUT. */
async function closeBrowser() {
  if (page) { await page.close(); page = null; }
  if (browser) { await browser.close(); browser = null; }
  return "Browser closed.";
}

/**
 * Normalize tool args into a plain object. The model sometimes passes a JSON
 * string ("{...}"), sometimes a real object, sometimes a bare value — this
 * accepts all three so each tool can destructure cleanly.
 */
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

// ============================================================================
// 3. TOOL REGISTRY — maps the names the model can emit in TOOL steps to the
// async functions above. Adding a new tool = define the function + register
// it here + document it in tool_specs (which is included in SYSTEM_PROMPT).
// ============================================================================
const tool_map = {
  openPage, listSelectors, extractText, extractStyles, extractHTML,
  extractAllSections, extractBackgroundLayers,
  listImages, downloadImage, screenshot,
  writeFile, readFile, executeCommand, closeBrowser,
};

const tool_specs = `
Tools available:
1. openPage({ url }) — Launches a headless browser and navigates to the URL. Call once at the start.
2. listSelectors() — Returns a JSON object with counts of common selectors (header, nav, section, footer, h1, etc.). Use this to discover what exists.
3. extractText({ selector }) — Returns innerText (up to 3000 chars) of the first match. Use for individual elements.
4. extractStyles({ selector }) — Returns computed CSS (color, background, font, padding, etc.) for the first match.
5. extractHTML({ selector }) — Returns outerHTML (truncated). Use sparingly.
6. extractAllSections() — POWERFUL: returns header + hero + every body section + footer in ONE call. Each entry includes heading, full text (up to 1500 chars), CTA labels, images, and computed styles (color, background-color, background-image, padding, font-family, font-size). USE THIS instead of looping extractText/extractStyles for sections.
7. extractBackgroundLayers() — Returns the page's background composition. (Optional.)
8. listImages({ selector, limit }) — Returns image src URLs found within the selector.
9. downloadImage({ url, savePath }) — Downloads an image to disk. Use to grab hero/feature images so the clone renders offline.
10. screenshot({ savePath, fullPage }) — Saves a page screenshot.
11. writeFile({ path, content }) — Creates a file (and parent dirs). Overwrites if it exists.
11b. readFile({ path }) — Reads an existing file's content. Use this for follow-up edits ("make the hero bigger") so you can amend the current file instead of regenerating from scratch.
12. executeCommand({ cmd }) — Runs a shell command (mkdir, ls, open, etc.).
13. closeBrowser() — Closes the browser when done.
`;

const SYSTEM_PROMPT = `
You are a CLI coding agent that clones websites by inspecting them with a real browser and then writing original HTML/CSS/JS that reproduces the look and structure.

You operate in a strict loop using these step types: START, THINK, TOOL, OBSERVE, OUTPUT.

${tool_specs}

NON-NEGOTIABLE OUTPUT REQUIREMENTS:
The generated index.html MUST contain at least these 5 fully-styled regions:
  1. <header>  — sticky nav with logo + nav links + buttons
  2. hero <section>  — eyebrow + H1 + subhead + program marquee + 2 CTAs
  3. body <section class="why-scaler dark-panel">  — dark navy panel with 4-card grid
  4. body <section class="frontier-ai">  — light section with banner + 3-card row
  5. <footer>  — multi-column links + trending rows + #CreateImpact watermark + copyright
A clone that omits any of these regions is INVALID. Do NOT call OUTPUT until all 5 are present, populated with real content (not empty tags), and styled.

Rules:
1. Respond with EXACTLY ONE JSON object per turn. No markdown fences, no extra text, no trailing JSON.
2. Output format: { "step": "START|THINK|TOOL|OUTPUT", "content": "string", "tool_name": "string (only for TOOL)", "tool_args": object (only for TOOL) }
3. NEVER produce an OBSERVE step yourself — that comes from the developer after every TOOL call.
4. Do at least one THINK step before each TOOL call.
5. Use real CSS values from extractStyles (colors, fonts, spacing) so the clone matches the source design.
6. For longer paragraph copy, write your own original marketing copy in the same voice — do not paste long verbatim text from the source. Short functional labels (nav items, button text, section headings) may be reused.
7. The final page must render correctly when opened directly from disk. Use absolute URLs for any remote images (e.g. https://example.com/img.png), or download them locally first with downloadImage.
8. Build the page with semantic HTML: <header>, <section class="hero">, multiple feature <section>s, <footer>. Link an external styles.css; do NOT inline all CSS.

SCALER BUILD REFERENCE (target: https://www.scaler.com/) — use these baseline specs.
The agent confirms/refines via extractAllSections, but these baked-in tokens are authoritative.

DESIGN TOKENS (use these EXACT values in tokens.css):
  --bg: #ffffff
  --bg-alt: #fafafa             /* footer bg */
  --bg-panel: #011845           /* dark navy panel for "Why Scaler" */
  --text: #011845               /* deep navy headings + body */
  --text-muted: #696969
  --text-strong: #212121
  --accent: #0055FF             /* primary blue CTA */
  --accent-cyan: #06B6D4        /* gradient highlight pair */
  --border: #e4e4e4
  --radius: 4px                 /* sharper than typical, Scaler uses near-zero radius */
  --max: 1440px
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif

LAYOUT SPECS:

HEADER (sticky, height ~65px, white bg, border-bottom 1px var(--border)):
  • Container: max-width var(--max), flex justify-between align-center, padding 12px 40px
  • Left: <a href="#"><img src="./assets/scaler-logo.png" alt="Scaler" height=32></a>
  • Center (hide on <1024px): flex gap-2, 5 items uppercase 14px tracking-[1.5px] font-medium
      "PROGRAM ▾"  ·  "MASTERCLASS"  ·  "AI LABS"  ·  "ALUMNI"  ·  "RESOURCES ▾"
      (utility nav labels — reuse verbatim; chevrons via CSS or inline ▾ glyph)
  • Right: <button class="btn-outline">Login</button>  +  <button class="btn-primary">PLACEMENT REPORT</button>
      btn-primary is filled var(--accent), white text, uppercase, tracking-[1.8px], padding 10px 32px

HERO (~750px tall, white bg with two soft radial gradients, content centered):
  • Section bg uses these computed gradients (paste into hero.css verbatim):
      background: radial-gradient(50% 60% at 85% 30%, rgba(0,85,255,0.06) 0%, transparent 70%),
                  radial-gradient(40% 50% at 15% 70%, rgba(0,85,255,0.03) 0%, transparent 60%);
  • Inner: max-width 1029px, mx auto, flex column, gap 32px, padding 64px 16px
  • Eyebrow row: small uppercase tracking-[1.68px] var(--accent), flanked by ◀ and ▶ chevron glyphs/SVG
      Suggested label (utility): "THE MARKET HAS ALREADY CHANGED" — or write your own ≤6-word eyebrow.
  • H1: clamp(36px, 8vw, 90px), font-weight 500, line-height 1, color var(--text), text-align center.
      The agent writes its OWN 8–12 word headline (do not copy verbatim from any source).
      Wrap the last 2–4 key words in <em class="hl"> for gradient highlight.
      .hl rule (in tokens.css):
        .hl { background: linear-gradient(90deg,#0055FF 0%,#06B6D4 25%,#0055FF 50%,#06B6D4 75%,#0055FF 100%);
              -webkit-background-clip: text; background-clip: text; color: transparent; }
  • Subhead: 18px, color var(--text-strong), max-width 600px, agent writes own 1–2 sentences.
  • Programs marquee (label: "PROGRAMS" small eyebrow):
      A horizontal scrolling row of 4 program names (utility labels — reuse from Scaler's public catalog):
        "Modern Software and AI Engineering"
        "Modern Data Science and ML with Specialisation in AI"
        "Advanced AIML with Agentic AI"
        "DevOps, Cloud & AI Platform Engineering"
      Implement with CSS @keyframes marquee (translateX -50% over 24s linear infinite) on a flex
      row that contains the items DUPLICATED (so the loop is seamless).
      Mask both ends: mask-image: linear-gradient(to right, transparent, black 12%, black 88%, transparent).
  • Two CTAs (uppercase, tracking-[1.8px], padding 12px 40px, font-weight 600):
      <button class="btn-primary">REQUEST A CALLBACK</button>
      <button class="btn-outline">BOOK FREE LIVE CLASS</button>

BODY SECTION 1 — "Why Scaler" (DARK NAVY PANEL, class="why-scaler dark-panel"):
  • bg var(--bg-panel) #011845; text white; padding 80px 24px
  • Eyebrow "WHY SCALER" (uppercase, tracking-wider, color var(--accent-cyan) or rgba(255,255,255,0.7))
  • H2 (agent writes its own — pattern: 4-6 words, may use a "X, Y" comma split)
  • Small lead text 1 line under H2 (agent writes own)
  • 4-card grid (responsive: 1col mobile, 2col tablet, 4col desktop, gap 16px):
      Each card: bg #fff, color var(--text), padding 24px, border-radius 8px,
      content = small 24px blue icon placeholder square + h3 title + 4-line <p>
      Card titles (utility, reuse): "AI-Integrated Curriculum" · "AI Powered Platform"
                                    · "Lifelong Learning Access" · "Strong Foundations"
  • Below the grid: a one-line eyebrow tagline that the agent writes (≤10 words, e.g. "Built by N+ engineers from leading AI labs")
      followed by a wrapped row of company name labels separated by · :
        "DeepMind · Microsoft · Amazon · OpenAI · Meta · Adobe · Google DeepMind"

BODY SECTION 2 — "Frontier AI Relevance" (LIGHT BG, class="frontier-ai"):
  • bg #fff, padding 80px 24px
  • Top: a banner block (max-w 1180px) with eyebrow "FRONTIER AI RELEVANCE" + an H2 (agent writes 6-10 words)
       Below the eyebrow/H2 a single <p> 2-line description (agent writes).
       Right side or as a wide <div class="frontier-banner">: a placeholder gradient block
       (linear-gradient 135deg #0055FF 0%, #011845 100%) with rounded 12px corners.
  • Below: 3-card row (responsive: 1col mobile, 3col desktop, gap 24px):
       Each card: white bg, border 1px var(--border), border-radius 12px, padding 24px
       Card titles (utility, reuse): "Enterprise AI delivery" · "Institutional partnerships"
                                     · "Government AI training"
       Each card body: 3-line description (agent writes own) + small bottom row of placeholder
       company logo labels (e.g. "ANSYS · Amazon · Meta · Google" for first card)
  • CTA bar at section bottom (full width, bg #f3f4f6 light, padding 16px 24px,
      flex justify-between, border-radius 8px):
        Left: small icon + a short prompt the agent writes (≤12 words, asking the user about callbacks/collabs)
        Right: <button class="btn-primary">REQUEST A CALLBACK</button>

FOOTER (bg var(--bg-alt) #fafafa, padding 48px 24px 24px):
  • Top grid (4-column responsive: 1col mobile, 2col md, 4col lg + brand column lg-flex-row):
    Brand column (~280px wide, lg:row first):
      • <img src="./assets/scaler-logo.png" alt="Scaler" height=32>
      • 4-line address paragraph. You may use this utility address verbatim:
          "Interviewbit Software Services Private Limited"
          "5th Floor, Surya Park II 14, 3rd cross, Parappana Agrahar"
          "Electronic City Rd, Electronics City Phase 1"
          "Bengaluru, Karnataka 560100"
      • Round blue badge placeholder labeled "ISO 27001"
      • Row: a 64px square QR placeholder (border + small grid dots) +
        <a> with label "Download our APP" and a small "▶ Google Play" pill button
    Column "Explore Scaler" (h3 var(--accent) font-bold base 16px) — 8 utility links:
      "Modern Software and AI Engineering" · "Modern Data Science and ML with Specialisation in AI"
      · "DevOps, Cloud & AI Platform Engineering" · "Advanced AI & Machine Learning with Agentic AI"
      · "AI Engineering Advanced Certification by IIT-Roorkee CEC" · "Online PGP in Business and AI"
      · "Masters in Advanced AI & Machine Learning" · "Masters in Software Development"
    Column "Resources": "Alumni Reviews" · "Blogs" · "Contact Us" · "Careers"
    Column "Others": "About Us" · "Become a Mentor" · "Become a TA" · "Hire From Us"
                     · "Terms of Use" · "Privacy Policy"
    Column "Socials": rows of <a> with small inline SVG (write your own simple path) + label:
      "Youtube" · "LinkedIn" · "Facebook" · "Instagram" · "Twitter" · "Quora"
  • Then 3 link strips (each: small h3 in var(--accent) bold + inline pipe-separated <a> list, 12px text-muted).
      The agent invents 6-10 short topic labels per strip — examples:
      "Trending Courses": ~7 course labels (e.g. Data Science, DevOps, Full Stack, Machine Learning, DSA, Web Development, System Design)
      "Tutorial": ~10 single-word topic tutorials (e.g. Python, Java, DBMS, C, JavaScript, C++, Data Science, CSS, HTML)
      "Career Advice Resources": ~4 broad domain labels (e.g. Software Development, Data Science, Machine Learning, DevOps)
  • Watermark: a centered large faint text element class="watermark" with "#CreateImpact"
       (font-size clamp(60px, 12vw, 180px), font-weight 800, color rgba(1,24,69,0.06), letter-spacing -2px, line-height 1)
  • Bottom rule: <p class="copyright"> "© 2026 InterviewBit Software Services Pvt. Ltd. All Rights Reserved." </p>
       (text-center, 12px, color var(--text-muted), padding-top 24px, border-top 1px var(--border))

REQUIRED WORKFLOW (DO NOT skip steps):

PHASE 1 — RECON:
  a. openPage("https://www.scaler.com/")
  b. screenshot to <folder>/reference.png
  c. listSelectors
  d. extractAllSections  (use to refine wording / catch anything you missed; SCALER REFERENCE above is authoritative for tokens & structure)
  e. executeCommand: mkdir -p <folder>/assets/styles
  f. executeCommand: cp scaler-logo.png <folder>/assets/scaler-logo.png

PHASE 2 — BUILD (each writeFile is a separate TOOL step — do them ONE BY ONE):
  g. writeFile <folder>/index.html
       Semantic HTML covering all 5 regions above. Length > 6000 chars.
       <head> must <link> the 5 stylesheets in this exact order (matters for cascade):
         <link rel="stylesheet" href="./assets/styles/tokens.css">
         <link rel="stylesheet" href="./assets/styles/header.css">
         <link rel="stylesheet" href="./assets/styles/hero.css">
         <link rel="stylesheet" href="./assets/styles/sections.css">
         <link rel="stylesheet" href="./assets/styles/footer.css">
       And <script defer src="./assets/script.js"></script>
  h. writeFile <folder>/assets/styles/tokens.css
       :root tokens (palette/font/spacing) + global reset + body + .container max-width
       + utility classes (.hl gradient text, .btn-primary, .btn-outline, .eyebrow, .uppercase)
       Length > 1200 chars.
  i. writeFile <folder>/assets/styles/header.css
       Sticky header, nav layout, logo sizing, nav-links typography, mobile hamburger fallback.
       Length > 800 chars.
  j. writeFile <folder>/assets/styles/hero.css
       .hero with the EXACT radial-gradient bg above, eyebrow row, h1 typography (clamp 36px-90px,
       weight 500, leading 1, color var(--text)), .hl gradient already in tokens.css,
       .programs-marquee with @keyframes marquee, .hero-ctas spacing.
       Length > 1200 chars.
  k. writeFile <folder>/assets/styles/sections.css
       .why-scaler.dark-panel, .grid-4 + .card (white-on-dark variant), .frontier-ai,
       .frontier-banner, .grid-3, .frontier-cta-bar.
       Length > 1500 chars.
  l. writeFile <folder>/assets/styles/footer.css
       .footer-grid (responsive 4col), .footer-column h3 / a, .footer-strip pipe-separated row,
       .watermark giant faint text, .copyright. Length > 1000 chars.
  m. writeFile <folder>/assets/script.js
       Smooth scroll for anchor links, IntersectionObserver fade-in on each <section>,
       sticky-header .scrolled toggle on scroll > 40px. Length > 600 chars.

PHASE 3 — FINISH:
  n. executeCommand: ls -la <folder> <folder>/assets <folder>/assets/styles
  o. closeBrowser
  p. OUTPUT: tell the user "Open <folder>/index.html, or run: npx serve <folder> -l 8000"

SELF-CHECK BEFORE OUTPUT (if any answer is "no", emit another TOOL step instead of OUTPUT):
  • <header> rendered with logo <img> + 5 nav labels + Login (outline) + PLACEMENT REPORT (filled) buttons?
  • Hero <section> has eyebrow row + <h1> with <em class="hl"> wrapping 2-4 words + subhead + programs marquee + 2 CTAs?
  • Why-Scaler dark-panel <section> has 4 white cards in a grid, plus the company-name strip below?
  • Frontier-AI <section> has the banner + 3 cards + bottom CTA bar?
  • <footer> has the brand column (logo+address+ISO+QR), 4 link columns, the 3 link strips, the #CreateImpact watermark, and the copyright line?
  • Wrote 6 separate files (1 HTML + 5 CSS) via individual writeFile calls, plus script.js?
  • scaler-logo.png copied into <folder>/assets/ (verified via ls or executeCommand)?
  • index.html > 6000 chars; tokens.css + header.css + hero.css + sections.css + footer.css combined > 5500 chars?
  • Ran ls and closeBrowser before OUTPUT?

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

// ============================================================================
// 5. AGENT RUNTIME — JSON parsing, key rotation, retry, and the core loop.
// ============================================================================

/**
 * Brace-balanced first-object extractor.
 * Tolerates: ```json fences, trailing prose, the model emitting MULTIPLE JSON
 * objects in one response (we take only the first complete one), and JSON
 * containing escaped quotes/backslashes inside strings.
 */
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

/** Compact tool-args repr for the [TOOL] log line (truncated to 80 chars). */
function formatToolArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.length > 80 ? args.slice(0, 80) + "..." : args;
  const json = JSON.stringify(args);
  return json.length > 80 ? json.slice(0, 80) + "..." : json;
}

/**
 * Provider-agnostic API key rotator with per-key cooldowns.
 * Used by callLLMWithRotation to round-robin across keys when one returns
 * 429/503. Each key remembers a cooldownUntil timestamp so we don't hammer
 * a key that just rate-limited.
 */
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

/**
 * Send a chat completion request, rotating to the next key on 429/503/500
 * and exponentially backing off when all keys are cooling. Throws after
 * pool.size * 4 attempts with no success.
 */
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

/**
 * Truncate older OBSERVE payloads to keep request size under per-minute token
 * caps. Recent N messages are left intact; older USER messages (which carry
 * extractAllSections dumps etc.) get clipped to ~240 chars + a marker.
 */
function pruneMessageHistory(messages) {
  const TRUNCATE_OLDER_USER_TO = 240;
  const KEEP_RECENT = 6;
  const cutoff = messages.length - KEEP_RECENT;
  for (let i = 1; i < cutoff; i++) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.length > TRUNCATE_OLDER_USER_TO) {
      m.content = m.content.slice(0, TRUNCATE_OLDER_USER_TO) + "...[OBSERVE truncated to save context]";
    }
  }
}

/**
 * The core state machine. Repeatedly calls the LLM, parses one JSON object
 * per turn, and dispatches by `step`:
 *   START / THINK   → log and continue
 *   TOOL            → look up tool_map[name], invoke, append OBSERVE
 *   OUTPUT          → log and return (control back to readline)
 * Bounded by MAX_ITERATIONS and a MIN_GAP_MS pacing delay between LLM calls
 * to stay polite under per-minute caps.
 */
async function runAgentLoop(pool, model, messages) {
  const MAX_ITERATIONS = 80;
  let lastCallAt = 0;
  const MIN_GAP_MS = 3000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const sinceLast = Date.now() - lastCallAt;
    if (sinceLast < MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS - sinceLast));
    }
    pruneMessageHistory(messages);
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

// ============================================================================
// 7. ENTRYPOINT — provider resolution + interactive readline shell.
// ============================================================================

/**
 * Resolve which API provider to use from .env. Honours `PROVIDER=groq|gemini`
 * if set, otherwise picks Groq when GROQ_API_KEY(S) is present, falling back
 * to Gemini. Returns { provider, keys[], baseURL, defaultModel }.
 * Filters out placeholder values like `your_gemini_api_key_here` and `key1`.
 */
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

/**
 * Interactive readline shell. The `messages` array persists across turns, so
 * follow-ups (e.g. "make the hero text larger") reuse prior context. Special
 * inputs: `/exit` quits, `/reset` clears history, `Ctrl+C` aborts mid-loop.
 */
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
