import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const capture = fs.readFileSync(path.join(root, '_shots_all.mjs'), 'utf8');
const planText = capture.match(/const PLAN = (\[[\s\S]*?\n\]);/);
if (!planText) throw new Error('Capture plan not found');
const plan = vm.runInNewContext('(' + planText[1] + ')', {}, { timeout: 1000 });
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sources = new Map();
function lines(file) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/));
  return sources.get(file);
}
function excerpt(file, anchor, count = 24) {
  const all = lines(file);
  const index = all.findIndex(l => l.includes(anchor));
  if (index < 0) throw new Error(`Missing source anchor: ${file}: ${anchor}`);
  return { file, startLine: index + 1, endLine: Math.min(all.length, index + count), code: all.slice(index, index + count).join('\n') };
}
const descriptions = {
  hero: 'Introduces the page and gives visitors links to the main services.',
  features: 'Groups the four service entry points into cards with links to the service guide.',
  announcements: 'Explains announcements and categories. The home newsboard is currently marked hidden; its old screenshot may show adjacent content.',
  directory: 'Lists the school offices and the concerns each office handles.',
  contact: 'Displays contact information and a message form. The shared script opens an email draft; it does not store inquiries in a database.',
  footer: 'Repeats school identity and navigation links at the bottom of the page.',
  timeline: 'Uses an ordered list to present school milestones chronologically. School history claims require confirmation from school records.',
  band: 'Presents the marching band title count and competition table. These are website content claims, not independently verified research findings.',
  cta: 'Provides links that let a reader return to the portal or contact the school.',
  enrollment: 'Provides enrollment instructions and a checklist. This guide is not a document upload or enrollment processing service.',
  records: 'Explains student identity, grade level, section and status. Grade level means the year level; subject grade management is not implemented.',
  payments: 'Explains payment channels and balance history. The backend records payments entered by staff; it does not process bank or GCash transactions.',
  departments: 'Lists teaching departments and explains where to direct academic concerns.',
  offices: 'Explains the responsibilities of non-teaching school offices.',
  'staff-login': 'Links staff to admin.html, which uses the existing administrator roles.',
  page: 'Displays an authentication entry state. This figure does not demonstrate a signed-in dashboard.',
  'menu-open': 'Shows the mobile navigation drawer and the links available to a visitor.'
};
const figures = [];
for (const item of plan) {
  for (const shot of item.shots) {
    const file = `${item.name}-${shot.label}.png`;
    if (!fs.existsSync(path.join(root, 'shots', file))) throw new Error('Missing figure: ' + file);
    let source;
    if (shot.openMenu) source = excerpt(item.url, '<aside class="side-menu"', 27);
    else if (item.url === 'student.html') source = excerpt(item.url, 'id="dashBlocked"', 18);
    else if (item.url === 'admin.html') source = excerpt(item.url, 'id="adminLogin"', 27);
    else if (shot.label === 'hero') source = excerpt(item.url, item.url === 'studentportal.html' ? '<section class="hero"' : '<section class="sub-hero"', 25);
    else if (shot.label === 'cta') source = excerpt(item.url, '<section class="cta-strip"', 20);
    else if (shot.label === 'footer') source = excerpt(item.url, '<footer class="site-footer"', 20);
    else source = excerpt(item.url, `id="${shot.label === 'announcements' && item.url === 'studentportal.html' ? 'announcements-list' : shot.label}"`, 26);
    figures.push({ id: 'FIG-' + String(figures.length + 1).padStart(2,'0'), image: '../' + file, page: item.url, title: item.name.replace(/^\d+-/, '').replaceAll('-', ' ') + ' — ' + shot.label, viewport: item.mobile ? '390 × 844' : '1366 × 900', explanation: descriptions[shot.label], source });
  }
}
fs.writeFileSync(path.join(dir, 'screenshots.json'), JSON.stringify({ note: 'Existing captures paired with current source excerpts; original captures have not been regenerated.', figures }, null, 2));
const rows = s => s.code.split('\n').map((line,i) => `<span class="line"><span class="number">${s.startLine+i}</span><span>${escape(line)}</span></span>`).join('');
const panels = figures.map(f => `<article id="${f.id}"><h2>${f.id}: ${escape(f.title)}</h2><p>${escape(f.explanation)}</p><div class="pair"><figure><img src="${f.image}" alt="${escape(f.title)}" loading="lazy"><figcaption>Existing website capture • ${f.viewport} • <a href="${f.image}">Open PNG</a></figcaption></figure><section class="editor" aria-label="Source code"><div class="titlebar">● ● <span>Source overview</span></div><div class="tab">${escape(f.source.file)}</div><pre><code>${rows(f.source)}</code></pre><div class="status">HTML · Lines ${f.source.startLine}–${f.source.endLine} · Actual project source excerpt</div></section></div></article>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SPA Website Documentation — Screenshots and Code</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f5f8;color:#172331;font:16px/1.6 system-ui,sans-serif}header,main{max-width:1600px;margin:auto;padding:28px}header{background:#112d25;color:white;max-width:none}header>div{max-width:1544px;margin:auto}h1{margin:0;font-size:30px}a{color:#17628e}header a{color:#a9defa}nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}nav a{padding:5px 10px;border:1px solid #668c80;border-radius:5px;text-decoration:none}article{background:white;padding:24px;margin:0 0 28px;border:1px solid #d8e0e8;border-radius:10px;scroll-margin-top:20px}article h2{margin-top:0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start}figure{margin:0;min-width:0}img{display:block;width:100%;height:auto;border:1px solid #d0d7df}figcaption{font-size:13px;padding-top:8px;color:#526170}.editor{min-width:0;background:#1e1e1e;color:#d4d4d4;border-radius:7px;overflow:hidden}.titlebar{background:#323233;padding:10px 15px;color:#9da4ab;font-size:12px}.titlebar span{margin-left:18px}.tab{background:#252526;border-top:2px solid #4daafc;padding:9px 18px;width:fit-content;font:13px Consolas,monospace}pre{margin:0;padding:14px 0;overflow:auto;max-height:650px;font:12px/1.7 Consolas,'Courier New',monospace}code{display:block;min-width:max-content}.line{display:flex;padding-right:16px;color:#9cdcfe}.number{display:inline-block;width:52px;flex-shrink:0;text-align:right;margin-right:18px;color:#858585;user-select:none}.status{background:#007acc;color:white;padding:5px 14px;font-size:12px}.note{border-left:4px solid #e0ab40;padding:12px;background:#fff9e9}@media(max-width:900px){.pair{grid-template-columns:1fr}header,main{padding:16px}article{padding:16px}}@media print{nav{display:none}article{break-before:page;padding:10px}.pair{grid-template-columns:1fr 1fr}pre{max-height:none;font-size:8px}header{color:black;background:white}}
</style></head><body><header><div><h1>Saint Patrick's Academy Website Documentation</h1><p>25 website screenshots beside real source code, with line numbers and an explanation of each section. The editor panels are styled for documentation; they are not screenshots of VS Code.</p><p><a href="RESEARCH-DOCUMENTATION.md">Research document</a> · <a href="ARCHITECTURE.md">Architecture</a> · <a href="CODE-OVERVIEW.md">Code overview</a></p><nav>${figures.map(f=>`<a href="#${f.id}">${f.id}</a>`).join('')}</nav></div></header><main><p class="note">Existing screenshots are paired with the current source. Hidden targets and repeated footer/contact captures may not show the intended section. Student and admin figures show authentication gates, not private dashboards. Browser print can save this gallery as a PDF.</p>${panels}</main></body></html>`;
fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log(`Built ${figures.length} figure/code pairs; all image files and source anchors exist.`);
