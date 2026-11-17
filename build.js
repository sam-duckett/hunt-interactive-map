// Bundles the app into one self-contained file: dist/hunt-interactive-map.html
// Run with: npm run build
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src");                 // the app lives here; paths below are relative to it
const read = p => fs.readFileSync(path.join(SRC, p));
const mime = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// Every image in maps/ and icons/ becomes a data URI, keyed by its relative path
const assets = {};
for (const dir of ["maps", "icons"]) {
  if (!fs.existsSync(path.join(SRC, dir))) continue;
  for (const f of fs.readdirSync(path.join(SRC, dir))) {
    const type = mime[path.extname(f).toLowerCase()];
    if (type) assets[`${dir}/${f}`] = `data:${type};base64,` + read(`${dir}/${f}`).toString("base64");
  }
}

// Fonts referenced from the CSS as url("fonts/...") are embedded straight into it
const css = read("styles.css").toString()
  .replace(/\/\*# sourceMappingURL=.*?\*\//g, "")
  .replace(/url\("?(fonts\/[^")]+)"?\)/g, (m, p) => `url("data:font/woff2;base64,${read(p).toString("base64")}")`);
if (css.includes("fonts/")) throw new Error("build.js couldn't embed a font; check the url() in src/styles.scss");
// Stamped into the page so you can tell which copy someone has, e.g. "17 Nov 2026" (the date only, no time of day)
const built = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
let html = read("index.html").toString();
html = html
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
  .replace('<script src="map-data.js"></script>', () =>
    `<script>window.ASSETS=${JSON.stringify(assets)};</script>\n<script>${read("map-data.js")}</script>`)
  .replace('<script src="main.js"></script>', () => `<script>${read("main.js")}</script>`)
  .replace('<p class="ver" id="ver">Development copy</p>', () => `<p class="ver" id="ver">Version: ${built}</p>`);

// If src/index.html's tags change, the replaces above silently miss: fail instead of shipping a broken file
for (const tag of ['href="styles.css"', 'src="map-data.js"', 'src="main.js"', 'Development copy'])
  if (html.includes(tag)) throw new Error(`build.js couldn't inline ${tag}; check the tags in src/index.html`);

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
const out = path.join("dist", "hunt-interactive-map.html");
fs.writeFileSync(path.join(__dirname, out), html);
console.log(`Built ${out} (${(html.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(assets).length} images)`);
