// Renders the one-page "stop fake proof of payment" guide in every outreach language to
// pages/public/guides/fake-proof-of-payment-<lang>.pdf (served by the Pages mirror; the Worker attaches it to T2).
// A dev-time tool, not CI: it needs playwright-core and a Chromium, and real fonts (Noto Sans, Noto Sans Arabic).
//   NODE_PATH=<dir with playwright-core> CHROMIUM=<path to chrome> FONTS=<dir with Noto*.ttf> node scripts/render_guides.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const G = JSON.parse(readFileSync(join(root, 'scripts/guides.json'), 'utf8'));
const FONTS = process.env.FONTS || '';
const LINK = 'https://tapstall.zlnew.workers.dev/onboard';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const face = (fam, file, w) => `@font-face{font-family:'${fam}';src:url('file://${join(FONTS, file)}');font-weight:${w}}`;
const page = (lang, t) => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><meta charset="utf-8"><title>${esc(t.title)}</title><style>
${face('G', 'NotoSans-Regular.ttf', 400)}${face('G', 'NotoSans-Bold.ttf', 700)}${face('GA', 'NotoSansArabic-Regular.ttf', 400)}${face('GA', 'NotoSansArabic-Bold.ttf', 700)}
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:${lang === 'ar' ? "'GA','G'" : "'G'"},sans-serif;color:#17201c;font-size:10.6pt;line-height:1.42}
.top{background:#0b6e4f;color:#fff;padding:13mm 15mm 9mm}.brand{font-weight:700;letter-spacing:.04em;font-size:10pt;opacity:.9}
h1{font-size:23pt;line-height:1.15;margin:3mm 0 2mm}.sub{font-size:11pt;opacity:.95;margin:0}
main{padding:7mm 15mm 0}h2{font-size:12.5pt;color:#0b6e4f;margin:5mm 0 1.6mm}ul,ol{margin:0;padding-inline-start:6mm}li{margin:.9mm 0}
.q{margin:4mm 0 0;padding:3mm 5mm;border-inline-start:3px solid #0b6e4f;background:#eef6f2;font-weight:700;font-size:12pt}
.cta{margin:6mm 0 0;padding:4.5mm 5mm;border:1.5px solid #0b6e4f;border-radius:3mm;display:flex;justify-content:space-between;gap:4mm;align-items:center}
.cta b{font-size:12.5pt}.cta a{color:#0b6e4f;font-weight:700;text-decoration:none;direction:ltr;unicode-bidi:isolate}.cta span{display:block;color:#3c4a44;font-size:9.6pt}
footer{position:absolute;bottom:9mm;inset-inline:15mm;font-size:8.6pt;color:#5a6762;border-top:1px solid #d5dfda;padding-top:2.5mm}
</style><body><div class="top"><div class="brand">TAPSTALL</div><h1>${esc(t.title)}</h1><p class="sub">${esc(t.sub)}</p></div><main>
<h2>${esc(t.h1)}</h2><ul>${t.b1.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>${esc(t.h2)}</h2><ol>${t.b2.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
<h2>${esc(t.h3)}</h2><p style="margin:0">${esc(t.p3)}</p><p class="q">${esc(t.quote)}</p>
<h2>${esc(t.h4)}</h2><ol>${t.b4.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
<div class="cta"><div><b>${esc(t.cta)}</b><span>${esc(t.note)}</span></div><a href="${LINK}">tapstall.zlnew.workers.dev/onboard</a></div>
</main><footer>${esc(t.from)} <span dir="ltr" style="unicode-bidi:isolate">P.O. Box 900, Bulawayo, Zimbabwe</span></footer></body></html>`;

const out = join(root, 'pages/public/guides');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext();
const pg = await ctx.newPage();
for (const [lang, t] of Object.entries(G)) {
  const tmp = join(process.env.TMPDIR || '/tmp', 'guide-' + lang + '.html');
  writeFileSync(tmp, page(lang, t));
  await pg.goto('file://' + tmp);
  await pg.evaluate(() => document.fonts.ready);
  await pg.setViewportSize({ width: 794, height: 1123 });                 // A4 at 96 dpi: measure what prints
  const h = await pg.evaluate(() => document.querySelector('main').getBoundingClientRect().bottom);
  if (h > 1123 - 80) throw new Error(lang + ': does not fit one page (' + Math.round(h) + 'px)');
  writeFileSync(join(out, 'fake-proof-of-payment-' + lang + '.pdf'), await pg.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  if (process.env.SHOTS) await pg.screenshot({ path: join(process.env.SHOTS, 'guide-' + lang + '.png'), fullPage: true });
  console.log(lang, Math.round(h));
}
await browser.close();
