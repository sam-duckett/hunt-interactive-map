const NAMES = [
  ["mammons-gulch", "Mammon’s Gulch"],
  ["stillwater-bayou", "Stillwater Bayou"],
  ["lawson-delta", "Lawson Delta"],
  ["desalle", "DeSalle"]
];

// Icon files live in /icons. If a file fails to load, the coloured glyph is shown.
const MAX_MARKS = 3;                    // most things you can mark on one tower
const STORE = "hunt-interactive-map-v1";   // browser storage key
const MAP_METRES = 1000;                // maps are about 1 km across, used for the route distance
const TYPES = [
  { id: "xp",        label: "Hunter XP",        file: "icons/hunter-xp.png", glyph: "XP", color: "#e0b020" },
  { id: "fourshot",  label: "Four Shot Boon",   file: "icons/four-shot.png", glyph: "4",  color: "#3f8fd2" },
  { id: "dumdum",    label: "DumDum Rounds",    file: "icons/dumdum.png",    glyph: "DD", color: "#d9762c" },
  { id: "explosive", label: "Explosive Rounds", file: "icons/explosive.png", glyph: "EX", color: "#c93a4b" },
  { id: "trait",     label: "Trait",            file: "icons/trait.png",     glyph: "T",  color: "#8a63d2" },
  { id: "nothing",   label: "Nothing",          file: "icons/nothing.svg",   glyph: "✕",  color: "#6b6b6b" }
];

// In the single-file build, images are embedded and looked up here; otherwise the path is used as-is
const asset = p => (window.ASSETS && window.ASSETS[p]) || p;

// ---- Route planning -------------------------------------------------------
// Visits every target once, starting at `start` and finishing at whichever extract
// gives the shortest total run (or anywhere, if no extracts are placed).
// Straight lines only: it doesn't know about roads, water or cliffs.
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLen = p => p.slice(1).reduce((s, q, i) => s + dist(p[i], q), 0);

function nearestNeighbour(start, pts) {
  const left = pts.slice(), path = [start];
  while (left.length) {
    const last = path[path.length - 1];
    let k = 0;
    left.forEach((q, i) => { if (dist(last, q) < dist(last, left[k])) k = i; });
    path.push(left.splice(k, 1)[0]);
  }
  return path;
}

function cheapestInsertion(start, pts, end) {
  const left = pts.slice(), path = [start, end];
  while (left.length) {
    let best = null;
    left.forEach((q, k) => {
      for (let i = 0; i < path.length - 1; i++) {
        const c = dist(path[i], q) + dist(q, path[i + 1]) - dist(path[i], path[i + 1]);
        if (!best || c < best.c) best = { c, k, i };
      }
    });
    path.splice(best.i + 1, 0, left.splice(best.k, 1)[0]);
  }
  return path;
}

// Untangle crossings by reversing stretches of the route. The start is always fixed;
// the end is fixed too when the route has to finish at an extract.
function twoOpt(path, endFixed) {
  const n = path.length, last = endFixed ? n - 2 : n - 1;
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 1; i < last; i++) for (let j = i + 1; j <= last; j++) {
      const a = path[i - 1], b = path[i], c = path[j], d = path[j + 1];
      const delta = dist(a, c) - dist(a, b) + (d ? dist(b, d) - dist(c, d) : 0);
      if (delta < -1e-9) { path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse()); improved = true; }
    }
  }
  return path;
}

// Try lifting each tower out of the route and dropping it into a better gap
function relocate(path, endFixed) {
  const len = () => pathLen(path), last = () => endFixed ? path.length - 2 : path.length - 1;
  let improved = false;
  for (let i = 1; i <= last(); i++) {
    const before = len(), [q] = path.splice(i, 1);
    let bestAt = i, bestLen = before;
    for (let j = 1; j <= last() + 1; j++) {
      path.splice(j, 0, q);
      const l = len();
      if (l < bestLen - 1e-9) { bestLen = l; bestAt = j; }
      path.splice(j, 1);
    }
    path.splice(bestAt, 0, q);
    if (bestAt !== i) improved = true;
  }
  return improved;
}

const polish = (path, endFixed) => { do twoOpt(path, endFixed); while (relocate(path, endFixed)); return path; };

// Exact best route by dynamic programming (Held-Karp). Fine up to about 12 targets.
function exactRoute(start, pts, exits) {
  const n = pts.length, full = (1 << n) - 1;
  const cost = new Float64Array((full + 1) * n).fill(Infinity), from = new Int8Array((full + 1) * n).fill(-1);
  pts.forEach((p, j) => cost[(1 << j) * n + j] = dist(start, p));
  for (let mask = 1; mask <= full; mask++) for (let j = 0; j < n; j++) {
    const c = cost[mask * n + j];
    if (!(mask >> j & 1) || c === Infinity) continue;
    for (let k = 0; k < n; k++) if (!(mask >> k & 1)) {
      const m2 = mask | 1 << k, c2 = c + dist(pts[j], pts[k]);
      if (c2 < cost[m2 * n + k]) { cost[m2 * n + k] = c2; from[m2 * n + k] = j; }
    }
  }
  let best = Infinity, bj = 0, be = null;
  for (let j = 0; j < n; j++) (exits.length ? exits : [null]).forEach(e => {
    const c = cost[full * n + j] + (e ? dist(pts[j], e) : 0);
    if (c < best) { best = c; bj = j; be = e; }
  });
  const order = [];
  for (let mask = full, j = bj; j >= 0;) { order.unshift(pts[j]); const pj = from[mask * n + j]; mask &= ~(1 << j); j = pj; }
  return [start, ...order, ...(be ? [be] : [])];
}

function planRoute(start, targets, exits) {
  if (targets.length && targets.length <= 12) return exactRoute(start, targets, exits);
  if (!targets.length) return exits.length ? [start, exits.reduce((a, b) => dist(start, a) <= dist(start, b) ? a : b)] : [start];
  if (!exits.length) return polish(nearestNeighbour(start, targets), false);
  let best = null;
  exits.forEach(end => {
    [cheapestInsertion(start, targets, end), nearestNeighbour(start, targets).concat([end])].forEach(p => {
      p = polish(p, true);
      if (!best || pathLen(p) < pathLen(best)) best = p;
    });
  });
  return best;
}

(() => {
  const coords = window.ENVELOPE_COORDS, labels = window.MAP_LABELS || {};
  const MAPS = NAMES.map(([id, name]) => ({ id, name, img: asset(`maps/${id}.webp`), pts: coords[id], labels: labels[id] || [] }));
  const T = Object.fromEntries(TYPES.map(t => [t.id, t]));
  const $ = id => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";

  // Per map, all saved in the browser and only cleared by the New match button:
  //   marks[mapId][towerIndex] = array of type ids
  //   skip[mapId]  = tower indexes you've decided not to bother with
  //   me[mapId]    = [x, y] where you are now, or null
  //   exits[mapId] = [[x, y], ...] extracts placed this match
  let marks, skip, me, exits, showNames = true, cur = 0, pop = null, mode = null;
  const isPt = p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && isFinite(n));
  const fresh = () => {
    marks = {}; skip = {}; me = {}; exits = {};
    MAPS.forEach(m => { marks[m.id] = m.pts.map(() => []); skip[m.id] = []; me[m.id] = null; exits[m.id] = []; });
  };
  function load() {
    fresh();
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "{}");
      if (typeof s.showNames === "boolean") showNames = s.showNames;
      MAPS.forEach(m => {
        (s.marks && s.marks[m.id] || []).slice(0, m.pts.length).forEach((v, i) => {
          if (Array.isArray(v)) marks[m.id][i] = v.filter(x => T[x]).slice(0, MAX_MARKS);
        });
        if (s.skip && Array.isArray(s.skip[m.id])) skip[m.id] = s.skip[m.id].filter(i => Number.isInteger(i) && i >= 0 && i < m.pts.length);
        if (s.me && isPt(s.me[m.id])) me[m.id] = s.me[m.id];
        if (s.exits && Array.isArray(s.exits[m.id])) exits[m.id] = s.exits[m.id].filter(isPt);
      });
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ marks, skip, me, exits, showNames })); } catch (e) {} }
  load();

  function icon(t) {
    const s = document.createElement("span");
    s.className = "ico";
    s.style.setProperty("--c", t.color);
    s.textContent = t.glyph;
    const i = new Image();
    i.alt = t.label;
    i.onload = () => { s.textContent = ""; s.classList.add("img"); s.appendChild(i); };
    i.src = asset(t.file);
    return s;
  }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || "", textContent: text || "" });
  const id = () => MAPS[cur].id;
  const isSkipped = i => skip[id()].includes(i);

  function closePop() { if (pop) { pop.el.remove(); pop = null; } }

  function changed() { save(); renderMarkers(); renderRoute(); renderTally(); syncPop(); }

  function toggle(i, t) {
    const list = marks[id()][i], k = list.indexOf(t);
    if (k >= 0) list.splice(k, 1);
    else if (t === "nothing") list.length = 0, list.push(t);                   // "Nothing" excludes everything else
    else if (list.length < MAX_MARKS) { const n = list.indexOf("nothing"); if (n >= 0) list.splice(n, 1); list.push(t); }
    else return;
    skip[id()] = skip[id()].filter(x => x !== i);                              // marking a tower means you went there
    if (k < 0) me[id()] = MAPS[cur].pts[i].slice();                           // ...so you're standing there now: the route replans from it
    changed();
  }

  function syncPop() {
    if (!pop) return;
    const list = marks[id()][pop.i];
    pop.btns.forEach(([t, b]) => {
      const on = list.includes(t);
      b.classList.toggle("sel", on);
      b.disabled = !on && t !== "nothing" && list.length >= MAX_MARKS;
    });
    pop.clear.hidden = !list.length;
    pop.skip.hidden = !!list.length;
    pop.skip.textContent = isSkipped(pop.i) ? "Include in route again" : "Skip this tower (not worth the run)";
  }

  function openPop(i, p) {
    closePop();
    const box = el("div", "pop panel" + (p[0] > 55 ? " fx" : "") + (p[1] > 55 ? " fy" : ""));
    box.style.left = p[0] + "%"; box.style.top = p[1] + "%";
    box.onclick = e => e.stopPropagation();
    box.appendChild(el("p", "pophead", "What was here?"));
    const btns = TYPES.map(t => {
      const b = el("button", "opt");
      b.append(icon(t), el("span", "lbl", t.label));
      b.onclick = () => toggle(i, t.id);
      box.appendChild(b);
      return [t.id, b];
    });
    box.appendChild(el("p", "pophint", `Pick up to ${MAX_MARKS} things for this tower`));
    const skipBtn = el("button", "unmark");
    skipBtn.onclick = () => {
      skip[id()] = isSkipped(i) ? skip[id()].filter(x => x !== i) : skip[id()].concat(i);
      changed();
    };
    const clear = el("button", "unmark", "Clear this tower");
    clear.onclick = () => { marks[id()][i] = []; changed(); };
    box.append(skipBtn, clear);
    $("wrap").appendChild(box);
    pop = { el: box, i, btns, clear, skip: skipBtn };
    syncPop();
  }

  // Map tabs, like the game's top menu: [Q] tab tab tab tab [E]
  function showMap(n) { cur = (n + MAPS.length) % MAPS.length; setMode(null); render(); }
  function renderTabs() {
    const tabs = $("tabs"); tabs.innerHTML = "";
    const cap = (k, step) => { const c = el("kbd", "", k); c.title = (step < 0 ? "Previous" : "Next") + " map"; c.onclick = () => showMap(cur + step); return c; };
    tabs.appendChild(cap("Q", -1));
    MAPS.forEach((x, n) => {
      const b = el("button", "", x.name);
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", n === cur);
      b.title = `${x.name} (${n + 1})`;
      b.onclick = () => showMap(n);
      tabs.appendChild(b);
    });
    tabs.appendChild(cap("E", 1));
  }

  function renderMarkers() {
    const m = MAPS[cur], mk = marks[m.id], w = $("wrap");
    w.querySelectorAll(".mk, .me, .exit").forEach(e => e.remove());
    m.pts.forEach((p, i) => {
      const list = mk[i], b = el("button", "mk" + (list.length ? " done" : "") + (!list.length && isSkipped(i) ? " skipped" : ""));
      b.style.left = p[0] + "%"; b.style.top = p[1] + "%";
      b.dataset.i = i;
      b.setAttribute("aria-label", "Tower " + (i + 1) + (list.length ? ": " + list.map(x => T[x].label).join(", ") : isSkipped(i) ? " (skipped)" : ""));
      list.forEach(t => b.appendChild(icon(T[t])));
      b.onclick = e => { e.stopPropagation(); openPop(i, p); };
      w.appendChild(b);
    });
    exits[m.id].forEach((p, k) => {
      const b = el("button", "exit");
      b.style.left = p[0] + "%"; b.style.top = p[1] + "%";
      b.title = "Extract (click to remove)"; b.setAttribute("aria-label", b.title);
      b.onclick = e => { e.stopPropagation(); exits[m.id].splice(k, 1); changed(); };
      w.appendChild(b);
    });
    if (me[m.id]) {
      const d = el("span", "me");
      d.style.left = me[m.id][0] + "%"; d.style.top = me[m.id][1] + "%";
      d.title = "You are here";
      w.appendChild(d);
    }
  }

  function renderRoute() {
    const m = MAPS[cur], w = $("wrap"), info = $("routeinfo");
    w.querySelector(".route")?.remove();
    w.querySelectorAll(".mk .ord").forEach(e => e.remove());
    const todo = m.pts.map((p, i) => i).filter(i => !marks[m.id][i].length && !isSkipped(i));
    if (!me[m.id]) {
      info.textContent = "Set your position to see a route.";
      return;
    }
    const byPt = new Map(todo.map(i => [m.pts[i], i]));
    const path = planRoute(me[m.id], todo.map(i => m.pts[i]), exits[m.id]);
    if (path.length < 2) { info.textContent = "Nothing left to check here."; return; }

    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "route");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = (pts, cls) => {
      const l = document.createElementNS(SVG, "polyline");
      l.setAttribute("points", pts.map(p => p.join(",")).join(" "));
      l.setAttribute("class", cls);
      l.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(l);
    };
    const ends = exits[m.id].length > 0;
    const towers = ends ? path.slice(0, -1) : path;
    line(towers, "leg");
    if (ends) line(path.slice(-2), "leg out");                                  // last leg, to the extract, is dashed
    w.insertBefore(svg, $("img").nextSibling);

    towers.slice(1).forEach((p, n) => {
      w.querySelector(`.mk[data-i="${byPt.get(p)}"]`)?.appendChild(el("span", "ord", n + 1));
    });
    const km = (pathLen(path) / 100 * MAP_METRES / 1000).toFixed(1);
    info.textContent = !todo.length ? `All checked. About ${km} km to the nearest extract.` : `${todo.length} to visit, about ${km} km` + (ends ? ", finishing at the best extract." : ". Add extracts to finish next to one.");
  }

  function renderLabels() {
    const w = $("wrap");
    w.querySelectorAll(".loc").forEach(e => e.remove());
    if (!showNames) return;
    MAPS[cur].labels.forEach(([name, x, y]) => {
      const d = el("span", "loc", name);
      d.style.left = x + "%"; d.style.top = y + "%";
      w.appendChild(d);
    });
  }

  function renderTally() {
    const all = marks[id()].flat(), tally = $("tally");
    tally.innerHTML = "";
    TYPES.forEach(t => {
      const li = document.createElement("li");
      li.append(icon(t), el("span", "lbl", t.label), el("b", "", all.filter(v => v === t.id).length));
      tally.appendChild(li);
    });
    const open = marks[id()].map((l, i) => i).filter(i => !marks[id()][i].length);
    const skipped = open.filter(isSkipped).length;
    $("left").textContent = open.length - skipped;
    $("skipped").textContent = skipped ? ` (${skipped} skipped)` : "";
  }

  function render() {
    closePop(); renderTabs();
    $("img").src = MAPS[cur].img;
    $("mapname").textContent = MAPS[cur].name;
    renderMarkers(); renderLabels(); renderRoute(); renderTally();
    $("names").checked = showNames;
  }

  // ---- Placing your position and extracts ----
  // mode is null, "me" (next map click sets your position) or "exit" (each map click adds an extract)
  function setMode(m) {
    mode = m;
    $("wrap").classList.toggle("placing", !!mode);
    $("setme").classList.toggle("on", mode === "me");
    $("addexit").classList.toggle("on", mode === "exit");
    $("addexit").querySelector(".lbl").textContent = mode === "exit" ? "Done adding extracts" : "Add extracts";
  }
  const mapPoint = e => {
    const r = $("img").getBoundingClientRect(), c = v => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
    return [c((e.clientX - r.left) / r.width * 100), c((e.clientY - r.top) / r.height * 100)];
  };
  $("setme").onclick = e => { e.stopPropagation(); closePop(); setMode(mode === "me" ? null : "me"); };
  $("addexit").onclick = e => { e.stopPropagation(); closePop(); setMode(mode === "exit" ? null : "exit"); };
  $("wrap").addEventListener("click", e => {
    if (!mode) return;
    e.stopPropagation();
    if (mode === "me") { me[id()] = mapPoint(e); setMode(null); }
    else exits[id()].push(mapPoint(e));
    changed();
  });
  $("wrap").addEventListener("contextmenu", e => {                               // right-click: "I'm here now"
    e.preventDefault(); closePop();
    me[id()] = mapPoint(e);
    if (mode === "me") setMode(null);
    changed();
  });

  $("names").onchange = e => { showNames = e.target.checked; save(); renderLabels(); };

  let armed = null;
  $("reset").onclick = e => {
    e?.stopPropagation?.();
    const lbl = $("reset").querySelector(".lbl");
    if (!armed) {
      lbl.textContent = "Sure? Press again";
      armed = setTimeout(() => { armed = null; lbl.textContent = "New match (wipe all)"; }, 3000);
      return;
    }
    clearTimeout(armed); armed = null;
    lbl.textContent = "New match (wipe all)";
    fresh(); save(); setMode(null); render();
  };

  document.addEventListener("click", closePop);

  // ---- Keyboard shortcuts (shown as keycaps on the page) ----
  //   Q / E previous / next map, 1-4 pick a map, P set my position, X add extracts,
  //   L location names, N new match (press twice), Esc close / cancel
  document.addEventListener("keydown", e => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (e.key === "Escape") { closePop(); setMode(null); return; }
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= String(MAPS.length)) return showMap(+k - 1);
    const act = { q: () => showMap(cur - 1), e: () => showMap(cur + 1),
                  p: () => $("setme").click(), x: () => $("addexit").click(),
                  l: () => $("names").click(), n: () => $("reset").click() }[k];
    if (act) { e.preventDefault(); act(); }
  });
  render();
})();
