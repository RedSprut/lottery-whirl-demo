#!/usr/bin/env node
/**
 * Lottery Whirl — local verification (local; no CI).
 *
 *   node test.mjs                    # chromium + webkit
 *   BROWSERS=chromium,webkit,firefox node test.mjs
 *   SHOTS=1 node test.mjs            # also refresh ./screenshots (chromium)
 *   SHOT_DIR=/some/dir …                                           # per-engine screenshots for review
 *   BASE_URL=https://redsprut.github.io/lottery-whirl-demo/ …      # check the published site
 *
 * Part 1 (Node): the generator against the registry — counts, ranges, uniqueness, draw order,
 * same-pool vs separate-pool semantics, uniformity, freshness.
 * Part 2 (browsers): every lottery × phone/tablet/desktop — ball count + order, extras styled
 * apart, no overlap, nothing clipped, caption clear of the balls, rapid switching, repeated
 * runs, no DOM/animation/timer accumulation, idle = no rAF, reduced motion, no JS errors,
 * frame timing under 4× CPU throttle (chromium).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES, GAME_IDS, ADDONS, generateCombination, randomIndex } from './combo.js';
import { createStandServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = { generator: {}, browsers: {} };
const log = (...a) => console.log(...a);

/* ───────────── Part 1: generator ───────────── */
function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }

for (const g of GAMES) {
  const N = 40000;
  const seenMain = new Map();
  const seenBonus = new Map();
  let sortedAsc = 0;
  let separateCoincide = 0;
  const keys = new Set();
  let dupes = 0;
  for (let i = 0; i < N; i++) {
    const c = generateCombination(g.id);
    assert.equal(c.gameId, g.id);
    assert.equal(c.main.length, g.main.draw, `${g.id}: main count`);
    assert.equal(new Set(c.main).size, c.main.length, `${g.id}: main repeats`);
    for (const v of c.main) {
      assert.ok(Number.isInteger(v) && v >= 1 && v <= g.main.max, `${g.id}: main ${v} out of 1..${g.main.max}`);
      seenMain.set(v, (seenMain.get(v) || 0) + 1);
    }
    if (c.main.every((v, j) => j === 0 || v > c.main[j - 1])) sortedAsc++;
    const bonus = c.extras.filter((x) => x.kind === 'bonus');
    const addon = c.extras.filter((x) => x.kind === 'addon');
    assert.equal(bonus.length, g.bonus ? g.bonus.draw : 0, `${g.id}: bonus count`);
    assert.equal(new Set(bonus.map((x) => x.value)).size, bonus.length, `${g.id}: bonus repeats inside its drum`);
    for (const x of bonus) {
      assert.ok(x.value >= 1 && x.value <= g.bonus.max, `${g.id}: bonus ${x.value} out of 1..${g.bonus.max}`);
      seenBonus.set(x.value, (seenBonus.get(x.value) || 0) + 1);
      if (g.bonus.strategy === 'same-main-pool') assert.ok(!c.main.includes(x.value), `${g.id}: same-pool bonus equals a main number`);
      else if (c.main.includes(x.value)) separateCoincide++;
    }
    const expectAddon = (ADDONS[g.id] || []).reduce((s, a) => s + a.draw, 0);
    assert.equal(addon.length, expectAddon, `${g.id}: addon count`);
    for (const x of addon) assert.ok(x.value >= 1 && x.value <= 90, `${g.id}: SuperStar ${x.value} out of 1..90`);
    if (i < 5000) {
      const key = `${c.main.join(',')}|${c.extras.map((x) => x.value).join(',')}`;
      if (keys.has(key)) dupes++;
      keys.add(key);
    }
  }
  // every number reachable, roughly uniform (each count within ±25 % of the mean at N=40k)
  assert.equal(seenMain.size, g.main.max, `${g.id}: not every main number appeared`);
  const meanMain = (N * g.main.draw) / g.main.max;
  for (const [v, n] of seenMain) assert.ok(Math.abs(n - meanMain) < meanMain * 0.25, `${g.id}: main ${v} drawn ${n}× vs mean ${meanMain.toFixed(0)}`);
  if (g.bonus) {
    const pool = g.bonus.strategy === 'same-main-pool' ? g.main.max : g.bonus.max;
    assert.equal(seenBonus.size, pool, `${g.id}: not every bonus number appeared`);
    const meanB = (N * g.bonus.draw) / pool;
    for (const [v, n] of seenBonus) assert.ok(Math.abs(n - meanB) < meanB * 0.3, `${g.id}: bonus ${v} drawn ${n}× vs mean ${meanB.toFixed(0)}`);
  }
  // draw order is kept: an ascending main row should be as rare as 1/k!
  const expectSorted = N / factorial(g.main.draw);
  assert.ok(sortedAsc <= expectSorted * 3 + 8, `${g.id}: ${sortedAsc} ascending rows of ${N} — looks sorted`);
  // separate-pool specials are independent: they DO sometimes equal a main number
  if (g.bonus?.strategy === 'separate-pool') assert.ok(separateCoincide > 0, `${g.id}: separate-pool bonus never coincided with a main number`);
  results.generator[g.id] = {
    rule: `${g.main.draw}/${g.main.max}` + (g.bonus ? ` + ${g.bonus.draw}/${g.bonus.max} ${g.bonus.strategy}` : '') + ((ADDONS[g.id] || []).map((a) => ` + ${a.draw}/${a.max} ${a.label}`).join('')),
    samples: N, ascendingRows: sortedAsc, ascendingExpected: Math.round(expectSorted), duplicatesIn5000: dupes, separateCoincidences: separateCoincide,
  };
}
{ // rejection sampler: no modulo bias at a bound that does not divide 2^32
  const counts = new Array(3).fill(0);
  for (let i = 0; i < 300000; i++) counts[randomIndex(3)]++;
  for (const c of counts) assert.ok(Math.abs(c - 100000) < 2500, `randomIndex(3) skew ${counts}`);
}
log('GENERATOR OK —', Object.entries(results.generator).map(([id, r]) => `${id} ${r.rule}`).join(' | '));

/* ───────────── Part 2: browsers ───────────── */
let pw;
try { pw = await import('playwright'); } catch { log('playwright missing — browser part skipped'); process.exit(0); }

// BASE_URL=https://redsprut.github.io/lottery-whirl-demo/ checks the published site instead of a local server.
const server = process.env.BASE_URL ? null : createStandServer();
if (server) await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;

const VIEWPORTS = [
  { name: 'iphone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'android', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  { name: 'iphone-landscape', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'ipad', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
];
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = process.env.SHOTS === '1';
const SHOT_DIR = process.env.SHOT_DIR || '';
const shotsDir = path.join(HERE, 'screenshots');
if (SHOTS) await fs.mkdir(shotsDir, { recursive: true });
if (SHOT_DIR) await fs.mkdir(SHOT_DIR, { recursive: true });

const waitPhase = (page, phase, sel = 'single', timeout = 15000) => page.waitForFunction(
  ([ph, s]) => (s === 'single' ? window.__whirl?.single?.phase === ph : window.__whirl?.tiles.every((t) => t.phase === ph)),
  [phase, sel], { timeout });

/** Geometry of the held composition inside one stage element. */
async function geometry(page, stageSel) {
  return page.evaluate((sel) => {
    const stage = document.querySelector(sel);
    const sr = stage.getBoundingClientRect();
    const balls = [...stage.querySelectorAll('.wh-ball')].map((b) => {
      const r = b.getBoundingClientRect();
      const body = b.querySelector('.wh-body');
      return {
        value: Number(b.dataset.value), cls: b.className, x: r.x + r.width / 2, y: r.y + r.height / 2, d: r.width,
        bg: getComputedStyle(body).backgroundColor, opacity: Number(getComputedStyle(b).opacity),
        num: body.querySelector('.wh-num').textContent, fontPx: parseFloat(getComputedStyle(body.querySelector('.wh-num')).fontSize),
      };
    });
    const cap = [...stage.querySelectorAll('.wh-cap-title, .wh-cap-legend, .wh-cap-note')].filter((n) => n.offsetParent !== null || getComputedStyle(n).display !== 'none').map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
    return { stage: { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, balls, cap: cap.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })) };
  }, stageSel);
}

function checkGeometry(tag, g, combo) {
  const expectVals = [...combo.main, ...combo.extras.map((x) => x.value)];
  assert.deepEqual(g.balls.map((b) => b.value), expectVals, `${tag}: balls/draw order`);
  assert.deepEqual(g.balls.map((b) => Number(b.num)), expectVals, `${tag}: rendered numbers`);
  const nMain = combo.main.length;
  g.balls.forEach((b, i) => assert.ok(i < nMain ? /wh-main/.test(b.cls) : /wh-(bonus|addon)/.test(b.cls), `${tag}: ball ${i} class ${b.cls}`));
  if (combo.extras.length) {
    const mainBg = g.balls[0].bg;
    for (const b of g.balls.slice(nMain)) assert.notEqual(b.bg, mainBg, `${tag}: extra ball painted like a main ball`);
  }
  const d = g.balls[0].d;
  assert.ok(d >= 26, `${tag}: balls too small (${d.toFixed(1)}px)`);
  assert.ok(g.balls[0].fontPx >= 10.5, `${tag}: numbers too small (${g.balls[0].fontPx}px)`);
  let minGap = Infinity;
  for (let i = 0; i < g.balls.length; i++) {
    const a = g.balls[i];
    assert.ok(a.opacity > 0.99, `${tag}: ball ${a.value} not fully visible (${a.opacity})`);
    const ring = /wh-(bonus|addon)/.test(a.cls) ? d * 0.11 : 0;
    const s = g.stage;
    assert.ok(a.x - d / 2 - ring >= s.x - 0.5 && a.x + d / 2 + ring <= s.x + s.w + 0.5 && a.y - d / 2 - ring >= s.y - 0.5 && a.y + d / 2 + ring <= s.y + s.h + 0.5, `${tag}: ball ${a.value} clipped by the stage`);
    for (let j = i + 1; j < g.balls.length; j++) {
      const b = g.balls[j];
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y) / d);
    }
    for (const c of g.cap) {
      const overlap = a.x + d / 2 > c.x && a.x - d / 2 < c.x + c.w && a.y + d / 2 > c.y && a.y - d / 2 < c.y + c.h;
      assert.ok(!overlap, `${tag}: caption overlaps ball ${a.value}`);
    }
  }
  assert.ok(minGap >= 1.12, `${tag}: balls too close / overlapping (min centre distance ${minGap.toFixed(2)}·d)`);
  return { d: Math.round(d), minGap: Number(minGap.toFixed(2)) };
}

for (const engineName of engines) {
  const type = pw[engineName];
  const browser = await type.launch();
  const eng = { viewports: {}, rapid: null, leaks: null, reduced: null, perf: null, grid: null, errors: [] };
  results.browsers[engineName] = eng;
  const ctxFor = async (vp, extra = {}) => {
    const o = { viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, ...extra };
    if (engineName !== 'firefox') { if (vp.isMobile) o.isMobile = true; if (vp.hasTouch) o.hasTouch = true; }
    return browser.newContext(o);
  };
  const watch = (page) => {
    page.on('pageerror', (e) => eng.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') eng.errors.push(`console: ${m.text()}`); });
  };

  // every lottery × every viewport × both compositions
  for (const vp of VIEWPORTS) {
    const ctx = await ctxFor(vp);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${URL0}?hold=1&speed=2`);
    await page.waitForFunction(() => window.__whirl?.ready);
    assert.equal(await page.evaluate(() => window.__whirl.themeSource), 'palette.json', 'palette must come from vendor/palette.json');
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(scroll <= 0, `${engineName}/${vp.name}: horizontal page scroll ${scroll}px`);
    const vpRes = {};
    for (const layout of ['ring', 'line']) {
      if (layout === 'line') {
        await page.click('#layout-seg [data-layout="line"]');
      }
      for (const id of GAME_IDS) {
        await page.evaluate((gid) => window.__whirl.select(gid), id);
        await waitPhase(page, 'hold');
        const combo = await page.evaluate(() => window.__whirl.single.combo);
        assert.equal(combo.gameId, id);
        const tag = `${engineName}/${vp.name}/${layout}/${id}`;
        const geo = checkGeometry(tag, await geometry(page, '#single-stage'), combo);
        vpRes[`${layout}:${id}`] = geo;
        await page.waitForTimeout(650); // caption fade-in
        const shotName = `${id}-${vp.name}${layout === 'line' ? '-line' : ''}`;
        if (SHOTS && engineName === 'chromium' && (vp.name === 'desktop' || vp.name === 'iphone') && (layout === 'ring' || vp.name === 'desktop')) {
          const target = vp.name === 'desktop' ? page.locator('#single-frame') : page;
          await target.screenshot({ path: path.join(shotsDir, `${shotName}.jpg`), type: 'jpeg', quality: 86 });
        }
        if (SHOT_DIR && (layout === 'ring' || vp.name === 'desktop')) await page.screenshot({ path: path.join(SHOT_DIR, `${engineName}-${shotName}.jpg`), type: 'jpeg', quality: 80 });
      }
    }
    await page.click('#layout-seg [data-layout="ring"]');
    eng.viewports[vp.name] = vpRes;
    await ctx.close();
  }

  // grid: all nine side by side
  {
    const ctx = await ctxFor(VIEWPORTS[4]);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${URL0}?view=grid&hold=1&speed=2`);
    await page.waitForFunction(() => window.__whirl?.ready);
    await waitPhase(page, 'hold', 'grid');
    const tiles = await page.evaluate(() => window.__whirl.tiles);
    assert.deepEqual(tiles.map((t) => t.gameId), GAME_IDS);
    const sizes = [];
    for (const [i, t] of tiles.entries()) {
      const geo = checkGeometry(`${engineName}/grid/${t.gameId}`, await geometry(page, `.st-tile:nth-child(${i + 1}) .wh-stage`), t.combo);
      sizes.push(geo.d);
    }
    await page.waitForTimeout(650);
    if (SHOTS && engineName === 'chromium') await page.locator('#grid').screenshot({ path: path.join(shotsDir, 'all-nine-grid.jpg'), type: 'jpeg', quality: 86 });
    if (SHOT_DIR) await page.locator('#grid').screenshot({ path: path.join(SHOT_DIR, `${engineName}-all-nine-grid.jpg`), type: 'jpeg', quality: 80 });
    eng.grid = { tiles: tiles.length, ballPx: sizes };
    await ctx.close();
  }

  // rapid switching, repeated generations, accumulation, idle
  {
    const ctx = await ctxFor(VIEWPORTS[0]);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${URL0}?speed=1`);
    await page.waitForFunction(() => window.__whirl?.ready);
    await waitPhase(page, 'idle', 'single', 20000);
    // after idle the canvas may finish fading its last sparks (≤ ~1 s), then the loop must stop
    await page.waitForFunction(() => !window.__whirl.single.looping, null, { timeout: 3000 });
    const baseline = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length - document.querySelectorAll('#info-combo *').length, anims: document.getAnimations().length, looping: window.__whirl.single.looping }));
    assert.equal(baseline.anims, 0, 'animations left at idle');
    assert.equal(baseline.looping, false, 'rAF loop still running at idle');
    // 60 switches, 25 ms apart, through the real buttons
    const order = [];
    for (let i = 0; i < 60; i++) order.push(GAME_IDS[(i * 7 + (i >> 2)) % 9]);
    for (const id of order) { await page.click(`#picker [data-game="${id}"]`); await page.waitForTimeout(25); }
    const mid = await page.evaluate(() => ({ balls: document.querySelectorAll('.wh-ball').length, stages: document.querySelectorAll('.wh-stage').length, canvases: document.querySelectorAll('canvas').length, combo: window.__whirl.single.combo }));
    const want = mid.combo.main.length + mid.combo.extras.length;
    assert.equal(mid.balls, want, `rapid switching left ${mid.balls} balls for a ${want}-ball combination`);
    assert.equal(mid.stages, 1); assert.equal(mid.canvases, 2);
    assert.equal(mid.combo.gameId, order.at(-1));
    // 40 fresh combinations via the button
    for (let i = 0; i < 40; i++) { await page.click('#random'); await page.waitForTimeout(15); }
    const hist = await page.evaluate(() => window.__whirl.history);
    const last = hist.slice(-40);
    const keys = new Set(last.map((h) => `${h.main}|${h.extras.map((x) => x.value)}`));
    assert.ok(keys.size >= 39, `40 generations gave only ${keys.size} distinct combinations`);
    await waitPhase(page, 'idle', 'single', 20000);
    await page.waitForFunction(() => !window.__whirl.single.looping, null, { timeout: 3000 });
    const after = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length - document.querySelectorAll('#info-combo *').length, anims: document.getAnimations().length, looping: window.__whirl.single.looping, particles: window.__whirl.single.particles, balls: document.querySelectorAll('.wh-ball').length }));
    assert.equal(after.nodes, baseline.nodes, `DOM grew from ${baseline.nodes} to ${after.nodes}`);
    assert.equal(after.anims, 0, 'animations accumulated');
    assert.equal(after.looping, false, 'rAF loop running at idle');
    assert.equal(after.balls, 0);
    eng.rapid = { switches: order.length, generations: 40, distinct: keys.size };
    eng.leaks = { baselineNodes: baseline.nodes, afterNodes: after.nodes, animsAtIdle: after.anims, loopAtIdle: after.looping, particlesAtIdle: after.particles };
    // grid ↔ single toggling does not leave engines behind
    for (let i = 0; i < 6; i++) { await page.click('#view-seg [data-view="grid"]'); await page.waitForTimeout(60); await page.click('#view-seg [data-view="single"]'); await page.waitForTimeout(60); }
    assert.equal(await page.evaluate(() => document.querySelectorAll('.wh-stage').length), 1, 'grid engines left behind');
    await ctx.close();
  }

  // reduced motion (system setting)
  {
    const ctx = await ctxFor(VIEWPORTS[0], { reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${URL0}?game=euroMillions`);
    await page.waitForFunction(() => window.__whirl?.ready);
    await waitPhase(page, 'hold');
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => ({ looping: window.__whirl.single.looping, particles: window.__whirl.single.particles, reduced: document.querySelector('.wh-stage').classList.contains('is-reduced') }));
    assert.equal(s.reduced, true); assert.equal(s.looping, false, 'reduced motion still runs the rAF loop'); assert.equal(s.particles, 0);
    checkGeometry(`${engineName}/reduced`, await geometry(page, '#single-stage'), await page.evaluate(() => window.__whirl.single.combo));
    await waitPhase(page, 'idle', 'single', 10000);
    eng.reduced = s;
    await ctx.close();
  }

  // frame timing (chromium: 4× CPU throttle ≈ a mid-range phone)
  if (engineName === 'chromium') {
    const ctx = await ctxFor(VIEWPORTS[0]);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${URL0}?game=lottoMax&hold=1`);
    await page.waitForFunction(() => window.__whirl?.ready);
    await waitPhase(page, 'hold');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const perf = await page.evaluate(() => new Promise((resolve) => {
      const frames = []; let last = performance.now(); let stop = false;
      const tick = (t) => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
      requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
      window.__whirl.random();
      const t0 = performance.now();
      const poll = () => {
        if (window.__whirl.single.phase === 'hold' && performance.now() - t0 > 500) {
          stop = true;
          const f = frames.slice(1).sort((a, b) => a - b);
          const pct = (q) => f[Math.min(f.length - 1, Math.floor(f.length * q))];
          resolve({ frames: f.length, avgFps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)), p50: Number(pct(0.5).toFixed(1)), p95: Number(pct(0.95).toFixed(1)), over50ms: f.filter((x) => x > 50).length });
        } else setTimeout(poll, 50);
      };
      poll();
    }));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    assert.ok(perf.avgFps >= 30, `throttled flight averages ${perf.avgFps} fps`);
    eng.perf = { cpuThrottle: 4, ...perf };
    await ctx.close();
  }

  await browser.close();
  assert.deepEqual(eng.errors, [], `${engineName}: JavaScript errors`);
  log(`${engineName.toUpperCase()} OK — ${Object.keys(eng.viewports).length} viewports × 9 lotteries × 2 layouts, grid, rapid ${eng.rapid.switches} switches, leaks ${JSON.stringify(eng.leaks)}${eng.perf ? `, perf ${JSON.stringify(eng.perf)}` : ''}`);
}

server?.close();
await fs.writeFile(process.env.RESULT_JSON || path.join(os.tmpdir(), 'lottery-whirl-result.json'), JSON.stringify(results, null, 2));
log('ALL OK');
