/**
 * Lottery Whirl — preview stand (local only; see README.md). Owns the UI; the engine owns the run.
 * Every listener is attached once here; every engine run is replaced through engine.play().
 */
import { GAME_IDS, gameById, generateCombination, ruleLine, ADDONS } from './combo.js';
import { loadThemes } from './themes.js';
import { createWhirl, prefersReducedMotion } from './whirl-engine.js';
import { DRUM_STRINGS } from './vendor/pool-labels.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const labelOf = (pool) => (pool.labelKey && DRUM_STRINGS[pool.labelKey]?.ru) || pool.label || pool.poolId;
const MAIN_LABEL = DRUM_STRINGS['pool.main']?.ru || 'Основные';
const NOTE = 'Демо-комбинация · не результат и не прогноз';

const state = {
  game: GAME_IDS.includes(params.get('game')) ? params.get('game') : 'vikinglotto',
  view: params.get('view') === 'grid' ? 'grid' : 'single',
  speed: Number(params.get('speed')) || 1,
  layout: params.get('layout') === 'line' ? 'line' : 'ring',
  hold: params.get('hold') === '1',
  auto: params.get('auto') === '1',
  reduced: params.get('reduced') === '1',
};

let themes = null;
let single = null;              // { engine, combo }
const tiles = new Map();        // gameId -> { engine, combo, timer }
const log = [];
let autoTimer = 0;

function specFor(combo) {
  const g = gameById(combo.gameId);
  const legend = [{ kind: 'main', text: `${combo.main.length} · ${MAIN_LABEL}` }];
  const groups = new Map();
  for (const x of combo.extras) {
    const key = x.poolId;
    const pool = x.kind === 'addon' ? (ADDONS[g.id] || []).find((a) => a.poolId === key) : g.bonus;
    if (!groups.has(key)) groups.set(key, { kind: x.kind === 'addon' ? 'addon' : 'bonus', n: 0, label: labelOf(pool) });
    groups.get(key).n++;
  }
  for (const grp of groups.values()) legend.push({ kind: grp.kind, text: `${grp.n} · ${grp.label}` });
  return {
    theme: themes.themes[g.id],
    main: combo.main,
    extras: combo.extras,
    caption: { title: g.name, legend, note: NOTE },
    label: `${g.name}: ${comboText(combo)}. ${NOTE}.`,
  };
}

function comboText(combo) {
  const g = gameById(combo.gameId);
  const parts = [`${MAIN_LABEL}: ${combo.main.join(', ')}`];
  const byPool = new Map();
  for (const x of combo.extras) {
    const pool = x.kind === 'addon' ? (ADDONS[g.id] || []).find((a) => a.poolId === x.poolId) : g.bonus;
    const label = labelOf(pool);
    byPool.set(label, [...(byPool.get(label) || []), x.value]);
  }
  for (const [label, vals] of byPool) parts.push(`${label}: ${vals.join(', ')}`);
  return parts.join(' · ');
}

const playOpts = () => ({
  speed: state.speed, layout: state.layout,
  holdMs: state.hold ? Infinity : undefined,
  reducedMotion: state.reduced ? true : 'auto',
});

function launch(target, combo) {
  target.combo = combo;
  const p = target.engine.play(specFor(combo), playOpts());
  p.then((r) => { if (!r.interrupted) scheduleAuto(target); });
  return p;
}

function scheduleAuto(target) {
  if (!state.auto) return;
  const gap = 650 / state.speed;
  if (target === single) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { if (state.auto && state.view === 'single') freshSingle(); }, gap);
  } else {
    clearTimeout(target.timer);
    target.timer = setTimeout(() => { if (state.auto && state.view === 'grid') launch(target, record(generateCombination(target.gameId))); }, gap + Math.random() * 400);
  }
}

function record(combo) {
  log.push({ ...combo, at: Date.now() });
  if (log.length > 60) log.shift();
  return combo;
}

function freshSingle() {
  const combo = record(generateCombination(state.game));
  launch(single, combo);
  renderInfo(combo);
}

function replaySingle() {
  if (!single.combo) return freshSingle();
  launch(single, single.combo);
  renderInfo(single.combo);
}

function renderInfo(combo) {
  const g = gameById(combo.gameId);
  $('info-name').textContent = g.name;
  $('info-rule').textContent = ruleLine(g.id, labelOf);
  const box = $('info-combo');
  box.replaceChildren();
  const add = (cls, v) => { const s = document.createElement('span'); s.className = cls; s.textContent = String(v); box.appendChild(s); };
  combo.main.forEach((v) => add('st-n st-n-main', v));
  combo.extras.forEach((x) => add(`st-n st-n-${x.kind}`, x.value));
  box.setAttribute('aria-label', comboText(combo));
}

/* ── picker ── */
function buildPicker() {
  const picker = $('picker');
  GAME_IDS.forEach((id, i) => {
    const g = gameById(id);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.game = id;
    b.title = `${g.label} — клавиша ${i + 1}`;
    for (const [k, v] of Object.entries(themes.themes[id])) b.style.setProperty(k, v);
    const sw = document.createElement('span');
    sw.className = 'st-sw';
    sw.innerHTML = '<i class="m"></i><i class="b"></i>';
    const name = document.createElement('span');
    name.className = 'st-pname';
    name.textContent = g.name.replace('SuperEnalotto', 'SuperEna\u00ADlotto'); // soft hyphen: breaks only on a phone
    const fmt = document.createElement('span');
    fmt.className = 'st-pfmt';
    fmt.textContent = `${g.main.draw}/${g.main.max}${g.bonus ? ` + ${g.bonus.draw}` : ''}${ADDONS[id] ? ' + ★' : ''}`;
    b.append(sw, name, fmt);
    picker.appendChild(b);
  });
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-game]');
    if (b) selectGame(b.dataset.game);
  });
}

function syncPicker() {
  for (const b of $('picker').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.game === state.game));
  document.documentElement.style.setProperty('--accent', themes.themes[state.game]['--hdr-a']);
  document.documentElement.style.setProperty('--accent-2', themes.themes[state.game]['--hdr-b']);
}

function selectGame(id) {
  state.game = id;
  syncPicker();
  if (state.view === 'grid') setView('single');
  else freshSingle();
  syncUrl();
}

/* ── grid (all nine side by side) ── */
function buildGrid() {
  const grid = $('grid');
  for (const id of GAME_IDS) {
    const tile = document.createElement('div');
    tile.className = 'st-tile';
    tile.dataset.game = id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `${gameById(id).name} — открыть крупно`);
    grid.appendChild(tile);
    tiles.set(id, { gameId: id, host: tile, engine: null, combo: null, timer: 0 });
  }
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.st-tile');
    if (t) selectGame(t.dataset.game);
  });
  grid.addEventListener('keydown', (e) => {
    const t = e.target.closest('.st-tile');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); selectGame(t.dataset.game); }
  });
}

function gridPlay(fresh) {
  for (const t of tiles.values()) {
    clearTimeout(t.timer);
    if (!t.engine) t.engine = createWhirl(t.host, { maxDpr: 1.5, particles: 0.8 });
    launch(t, fresh || !t.combo ? record(generateCombination(t.gameId)) : t.combo);
  }
}

function gridStop() {
  for (const t of tiles.values()) {
    clearTimeout(t.timer);
    if (t.engine) { t.engine.destroy(); t.engine = null; }
  }
}

function setView(view) {
  state.view = view;
  for (const b of $('view-seg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.view === view));
  const grid = view === 'grid';
  $('grid').hidden = !grid;
  $('single-frame').hidden = grid;
  document.body.classList.toggle('is-grid', grid);
  clearTimeout(autoTimer);
  if (grid) { single.engine.stop(); gridPlay(true); } else { gridStop(); freshSingle(); }
  syncUrl();
}

/* ── controls ── */
function bindSeg(id, attr, apply) {
  const seg = $(id);
  const sync = () => { for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset[attr] === String(apply.value()))); };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    apply.set(b.dataset[attr]);
    sync();
  });
  sync();
}

function replayAll() { if (state.view === 'grid') gridPlay(false); else replaySingle(); }
function randomAll() { if (state.view === 'grid') gridPlay(true); else freshSingle(); }

function bindControls() {
  $('replay').addEventListener('click', replayAll);
  $('random').addEventListener('click', randomAll);
  bindSeg('speed-seg', 'speed', { value: () => state.speed, set: (v) => { state.speed = Number(v); syncUrl(); replayAll(); } });
  bindSeg('layout-seg', 'layout', { value: () => state.layout, set: (v) => { state.layout = v; syncUrl(); replayAll(); } });
  bindSeg('view-seg', 'view', { value: () => state.view, set: (v) => { if (v !== state.view) setView(v); } });
  const hold = $('opt-hold'); const auto = $('opt-auto'); const red = $('opt-reduced');
  hold.checked = state.hold; auto.checked = state.auto; red.checked = state.reduced;
  hold.addEventListener('change', () => {
    state.hold = hold.checked; syncUrl();
    if (!state.hold) { single.engine.release(); for (const t of tiles.values()) t.engine?.release(); }
  });
  auto.addEventListener('change', () => {
    state.auto = auto.checked; syncUrl();
    if (state.auto && state.view === 'single' && single.engine.phase === 'idle') freshSingle();
  });
  red.addEventListener('change', () => { state.reduced = red.checked; syncUrl(); replayAll(); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select')) return;
    const onButton = e.target.closest('button, [role="button"]');
    if (e.key === ' ' && !onButton) { e.preventDefault(); randomAll(); }
    else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') replayAll();
    else if (/^[1-9]$/.test(e.key)) selectGame(GAME_IDS[Number(e.key) - 1]);
    else if (e.key === 'g' || e.key === 'G') setView(state.view === 'grid' ? 'single' : 'grid');
  });
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('game', state.game);
  if (state.view !== 'single') p.set('view', state.view);
  if (state.speed !== 1) p.set('speed', String(state.speed));
  if (state.layout !== 'ring') p.set('layout', state.layout);
  if (state.hold) p.set('hold', '1');
  if (state.auto) p.set('auto', '1');
  if (state.reduced) p.set('reduced', '1');
  window.history.replaceState(null, '', `?${p}`);
}

async function boot() {
  themes = await loadThemes(GAME_IDS);
  $('info-source').textContent = themes.source === 'palette.json'
    ? 'Цвета и правила — из приложения Lotto Simulator (vendor/palette.json, vendor/registry.js).'
    : `Внимание: цвета из запасной палитры (${themes.missing.join(', ') || 'palette.json недоступен'}).`;
  buildPicker();
  buildGrid();
  single = { engine: createWhirl($('single-stage'), {}), combo: null };
  bindControls();
  syncPicker();
  if (prefersReducedMotion() && !params.has('reduced')) $('opt-reduced').closest('label').title = 'Система уже просит меньше движения';
  if (state.view === 'grid') setView('grid'); else freshSingle();
  window.__whirl.ready = true;
}

window.__whirl = {
  ready: false,
  get themeSource() { return themes?.source; },
  get themes() { return themes; },
  games: GAME_IDS,
  get state() { return { ...state }; },
  get history() { return log.map((h) => ({ ...h, main: [...h.main], extras: h.extras.map((x) => ({ ...x })) })); },
  get single() { return single && { phase: single.engine.phase, looping: single.engine.looping, particles: single.engine.particleCount, layout: single.engine.layout, combo: single.combo }; },
  get tiles() { return [...tiles.values()].map((t) => ({ gameId: t.gameId, phase: t.engine?.phase || 'none', combo: t.combo, layout: t.engine?.layout || null })); },
  generate: generateCombination,
  select: (id) => selectGame(id),
  random: () => randomAll(),
  replay: () => replayAll(),
  view: (v) => setView(v),
};

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<div class="st-fatal">Стенд не запустился: ${String(err && err.message || err).replace(/[<>&]/g, '')}</div>`);
});
