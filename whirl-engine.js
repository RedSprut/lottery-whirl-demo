/**
 * Lottery Whirl engine — EXPERIMENTAL, for the owner's visual approval only.
 * Not imported by the app; the production splash (#loto-splash in index.html) is untouched.
 *
 * One run:  burst  → every ball of the combination leaves the core AT ONCE on its own spiral
 *           flight → (own sweep, spin, inertia overshoot) and settles into a readable composition
 *           hold   → still, crisp, screenshot-able (only a 2–3 % CSS float)
 *           exit   → the balls drift on along the vortex and dissolve into sparks
 *           idle   → every ball node, animation and timer is gone; the canvas is cleared.
 *
 * Cost model: ≤ 9 ball nodes moved with transform/opacity only; one rAF loop that runs only
 * while something moves (none during hold/idle); glow layers animated by WAAPI on the
 * compositor; particles + trails on one 2D canvas (≤ ~150 sprites, no shadowBlur, no filters).
 * A new play() first tears the previous run down completely (stop()).
 */

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p, k = 1.25) => 1 + (k + 1) * (p - 1) ** 3 + k * (p - 1) ** 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** Timeline at 1× (ms). Speed divides all of it. */
export const TIMING = Object.freeze({ launch: 90, flight: 1380, settle: 420, hold: 1900, exit: 820, reducedFade: 420 });

const DEFAULTS = Object.freeze({
  speed: 1, layout: 'ring', holdMs: TIMING.hold, reducedMotion: 'auto', caption: true,
  maxDpr: 2, particles: 1, onPhase: null,
});

const BALL_CAP = { ring: 104, line: 92 };

/**
 * Composition geometry in px, relative to the composition centre.
 * ring: main balls on a circle (clockwise from 12 o'clock, draw order), extras in the core.
 * line: main row, then the extras after a gap — or a second row when that is larger.
 */
export function computeLayout({ mainCount, extraCount, layout, width, height, captionH = 0 }) {
  const boxW = Math.max(40, width * 0.92);
  const boxH = Math.max(40, (height - captionH) * 0.9);
  const cx = width / 2;
  const cy = (height - captionH) / 2 + Math.min(captionH * 0.12, 8);
  const pts = [];
  let plus = null;
  let d;
  let extentR;

  if (layout === 'line') {
    const g = 0.22; const sep = 0.78; const vgap = 0.62; const pad = 0.3;
    const mainW = mainCount + (mainCount - 1) * g;
    const extW = extraCount ? extraCount + (extraCount - 1) * g : 0;
    const oneW = mainW + (extraCount ? sep + extW : 0) + pad;
    const twoW = Math.max(mainW, extW) + pad;
    const twoH = (extraCount ? 2 + vgap : 1) + pad;
    const dOne = Math.min(boxW / oneW, boxH / (1 + pad));
    const dTwo = extraCount ? Math.min(boxW / twoW, boxH / twoH) : 0;
    const twoRows = dTwo > dOne * 1.06;
    d = Math.min(twoRows ? dTwo : dOne, BALL_CAP.line);
    const step = d * (1 + g);
    if (!twoRows) {
      const total = (oneW - pad) * d;
      let x = -total / 2 + d / 2;
      for (let i = 0; i < mainCount; i++, x += step) pts.push({ x, y: 0 });
      if (extraCount) {
        const last = pts[mainCount - 1].x;
        plus = { x: last + d / 2 + (d * sep) / 2, y: 0 };
        x = last + d * (1 + sep);
        for (let i = 0; i < extraCount; i++, x += step) pts.push({ x, y: 0 });
      }
      extentR = total / 2;
    } else {
      const rowY = (d * (1 + vgap)) / 2;
      let x = -(mainW * d) / 2 + d / 2;
      for (let i = 0; i < mainCount; i++, x += step) pts.push({ x, y: -rowY });
      x = -(extW * d) / 2 + d / 2;
      for (let i = 0; i < extraCount; i++, x += step) pts.push({ x, y: rowY });
      extentR = Math.hypot((mainW * d) / 2, rowY + d / 2);
    }
  } else {
    const g = 0.26; const gIn = 0.34; const clear = 0.36; const pad = 0.34;
    const innerHalf = extraCount <= 1 ? 0.5 : 1 + gIn / 2;
    const ringR = Math.max((1 + g) / (2 * Math.sin(Math.PI / mainCount)), (extraCount ? innerHalf : 0) + 0.5 + clear, 1.55);
    const total = 2 * ringR + 1 + pad;
    d = Math.min(boxW / total, boxH / total, BALL_CAP.ring);
    for (let i = 0; i < mainCount; i++) {
      const a = -Math.PI / 2 + (i * TAU) / mainCount;
      pts.push({ x: Math.cos(a) * ringR * d, y: Math.sin(a) * ringR * d });
    }
    if (extraCount === 1) pts.push({ x: 0, y: 0 });
    else for (let i = 0; i < extraCount; i++) pts.push({ x: (i - (extraCount - 1) / 2) * d * (1 + gIn), y: 0 });
    extentR = ringR * d + d / 2;
  }
  return { d, cx, cy, pts, plus, extentR };
}

/* ───────────────────────── particles + trails (one 2D canvas) ───────────────────────── */

function makeSprite(color) {
  const s = 48;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  try { grd.addColorStop(0.22, color); } catch (_e) { grd.addColorStop(0.22, '#ffffff'); }
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return c;
}

class Fx {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.ps = [];
    this.sprites = [];
    this.w = 0; this.h = 0; this.dpr = 1;
    this.inkUntil = 0;
  }
  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.c.width = Math.max(1, Math.round(w * dpr));
    this.c.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  palette(colors) { this.sprites = colors.map(makeSprite); }
  /** Vortex burst from the core: radial + tangential velocity, curled by swirl. */
  burst(cx, cy, n, dir, reach) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = reach * rand(1.1, 2.6);
      const tang = rand(0.55, 1.1) * dir;
      this.ps.push({
        x: cx + Math.cos(a) * 4, y: cy + Math.sin(a) * 4,
        vx: Math.cos(a) * sp - Math.sin(a) * sp * tang, vy: Math.sin(a) * sp + Math.cos(a) * sp * tang,
        cx, cy, swirl: dir * rand(1.2, 2.4), drag: rand(1.6, 2.4),
        age: 0, life: rand(0.8, 1.7), size: rand(1.2, 3.2), spr: i % this.sprites.length, a: rand(0.5, 0.9),
      });
    }
  }
  sparkle(x, y, n, spr, radius) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = radius * rand(0.6, 1.5);
      this.ps.push({
        x: x + Math.cos(a) * radius * 0.45, y: y + Math.sin(a) * radius * 0.45,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - radius * 0.3, cx: x, cy: y, swirl: 0, drag: 2.6,
        age: 0, life: rand(0.45, 0.85), size: rand(0.9, 2.1), spr, a: rand(0.45, 0.8),
      });
    }
  }
  trail(x0, y0, x1, y1, width, color, alpha) {
    const g = this.ctx;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    this.inkUntil = performance.now() + 700;
  }
  /** Fade the previous frame (gives trails their tail), then move + draw particles. */
  step(dt, now) {
    const g = this.ctx;
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = 1;
    g.fillStyle = `rgba(0,0,0,${1 - 0.72 ** (dt / 16.67)})`;
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
    const s = dt / 1000;
    let w = 0;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      p.age += s;
      if (p.age >= p.life) continue;
      if (p.swirl) {
        const dx = p.x - p.cx; const dy = p.y - p.cy; const r = Math.hypot(dx, dy) || 1;
        const k = (p.swirl * 160 * s) / Math.max(r / 60, 0.6);
        p.vx += (-dy / r) * k; p.vy += (dx / r) * k;
      }
      const f = Math.exp(-p.drag * s);
      p.vx *= f; p.vy *= f;
      p.x += p.vx * s; p.y += p.vy * s;
      const t = p.age / p.life;
      g.globalAlpha = p.a * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
      const sz = p.size * (1 + t * 0.6) * 2;
      const spr = this.sprites[p.spr];
      if (spr) g.drawImage(spr, p.x - sz, p.y - sz, sz * 2, sz * 2);
      this.ps[w++] = p;
    }
    this.ps.length = w;
    if (w) this.inkUntil = now + 700;
    g.globalAlpha = 1;
    return w > 0 || now < this.inkUntil;
  }
  clear() {
    this.ps.length = 0;
    this.inkUntil = 0;
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}

/* ───────────────────────── galaxy swirl (drawn once per theme) ───────────────────────── */

function drawSwirl(canvas, inner, mid, outer) {
  const S = canvas.width;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const sprites = [makeSprite(inner), makeSprite(mid), makeSprite(outer)];
  const arms = 3;
  for (let a = 0; a < arms; a++) {
    const base = (a * TAU) / arms;
    for (let i = 0; i < 260; i++) {
      const t = i / 259;
      const ang = base + t * TAU * 0.95;
      const r = S * (0.05 + t * 0.43);
      const jitter = S * 0.012 * (Math.random() - 0.5);
      const x = S / 2 + Math.cos(ang) * (r + jitter);
      const y = S / 2 + Math.sin(ang) * (r + jitter);
      const size = S * (0.05 * (1 - t) + 0.008);
      g.globalAlpha = 0.11 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.012;
      g.drawImage(sprites[t < 0.33 ? 0 : t < 0.7 ? 1 : 2], x - size, y - size, size * 2, size * 2);
    }
  }
  for (let i = 0; i < 160; i++) { // fine dust riding the arms
    const t = Math.random();
    const ang = (Math.floor(Math.random() * arms) * TAU) / arms + t * TAU * 0.95 + rand(-0.12, 0.12);
    const r = S * (0.06 + t * 0.43);
    const size = S * rand(0.003, 0.008);
    g.globalAlpha = rand(0.25, 0.7) * (1 - t * 0.6);
    g.drawImage(sprites[2], S / 2 + Math.cos(ang) * r - size, S / 2 + Math.sin(ang) * r - size, size * 2, size * 2);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/* ───────────────────────── engine ───────────────────────── */

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function isDarkText(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return false;
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  const n = parseInt(h, 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128;
}

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) { return false; }
}

export function createWhirl(host, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stage = el('div', 'wh-stage', host);
  stage.dataset.phase = 'idle';
  stage.setAttribute('role', 'img');
  el('div', 'wh-bg', stage);
  const halo = el('div', 'wh-halo', stage);
  const swirlWrap = el('div', 'wh-swirl-wrap', stage);
  const swirl = el('canvas', 'wh-swirl', swirlWrap);
  swirl.width = swirl.height = 512;
  const flare = el('div', 'wh-flare', stage);
  const canvas = el('canvas', 'wh-fx', stage);
  const layer = el('div', 'wh-balls', stage);
  const caption = el('div', 'wh-caption', stage);
  caption.setAttribute('aria-hidden', 'true');
  const fx = new Fx(canvas);

  let W = 0; let H = 0;
  let geo = null;
  let run = null;
  let raf = 0;
  let lastNow = 0;
  let themeKey = '';
  let destroyed = false;

  const emit = (phase) => {
    stage.dataset.phase = phase;
    if (run) run.phase = phase;
    try { opts.onPhase?.(phase, run?.spec || null); } catch (_e) { /* listener errors never break the run */ }
  };

  function measure() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr);
    fx.resize(W, H, dpr);
  }

  function relayout() {
    if (!run) return;
    const capH = opts.caption && run.spec.caption ? Math.min(Math.max(H * 0.15, 46), 92) : 0;
    geo = computeLayout({ mainCount: run.spec.main.length, extraCount: run.spec.extras.length, layout: run.layout, width: W, height: H, captionH: capH });
    stage.style.setProperty('--d', `${geo.d}px`);
    stage.style.setProperty('--cx', `${geo.cx}px`);
    stage.style.setProperty('--cy', `${geo.cy}px`);
    stage.style.setProperty('--comp', `${geo.extentR * 2}px`);
    stage.style.setProperty('--cap-h', `${capH}px`);
    run.balls.forEach((b, i) => {
      const p = geo.pts[i];
      b.fx = p.x; b.fy = p.y;
      b.R = Math.hypot(p.x, p.y);
      b.phi = b.R > 0.5 ? Math.atan2(p.y, p.x) : b.loopPhi;
    });
    if (run.plusNode) {
      run.plusNode.hidden = !geo.plus;
      if (geo.plus) run.plusNode.style.transform = `translate(${geo.cx + geo.plus.x}px, ${geo.cy + geo.plus.y}px) translate(-50%,-50%)`;
    }
    if (run.phase === 'hold' || run.reduced) placeStill();
  }

  const ro = new ResizeObserver(() => { measure(); relayout(); });
  ro.observe(stage);
  measure();

  function applyTheme(theme) {
    for (const [k, v] of Object.entries(theme)) stage.style.setProperty(k, v);
    stage.style.setProperty('--wh-a', theme['--hdr-a']);
    stage.style.setProperty('--wh-b', theme['--hdr-b']);
    stage.style.setProperty('--wh-c', theme['--hdr-c']);
    const key = [theme['--gm-hi'], theme['--hdr-a'], theme['--hdr-c']].join('|');
    if (key !== themeKey) {
      themeKey = key;
      drawSwirl(swirl, theme['--gm-hi'], theme['--hdr-a'], theme['--hdr-c']);
    }
    fx.palette(['#ffffff', theme['--gm-hi'], theme['--hdr-a'], theme['--gb-hi'] || theme['--gm-hi']]);
  }

  function buildBalls(spec) {
    const frag = document.createDocumentFragment();
    const balls = [];
    const make = (value, kind, extra) => {
      const node = el('div', `wh-ball wh-${kind}`);
      const body = el('div', 'wh-body', node);
      const num = el('span', 'wh-num', body);
      num.textContent = String(value);
      node.dataset.value = String(value);
      if (extra?.poolId) node.dataset.pool = extra.poolId;
      body.style.animationDelay = `${-rand(0, 3.4).toFixed(2)}s`;
      frag.appendChild(node);
      balls.push({ node, num, kind, extra: kind !== 'main', loopPhi: Math.random() * TAU });
    };
    spec.main.forEach((v) => make(v, 'main'));
    spec.extras.forEach((x) => make(x.value, x.kind === 'addon' ? 'addon' : 'bonus', x));
    let plusNode = null;
    if (spec.extras.length) {
      plusNode = el('div', 'wh-plus');
      plusNode.textContent = '+';
      frag.appendChild(plusNode);
    }
    layer.replaceChildren(frag);
    return { balls, plusNode };
  }

  function buildCaption(spec) {
    caption.replaceChildren();
    if (!opts.caption || !spec.caption) return;
    el('div', 'wh-cap-title', caption).textContent = spec.caption.title;
    const legend = el('div', 'wh-cap-legend', caption);
    for (const item of spec.caption.legend || []) {
      const chip = el('span', `wh-cap-chip wh-cap-${item.kind}`, legend);
      el('i', '', chip);
      chip.append(item.text);
    }
    if (spec.caption.note) el('div', 'wh-cap-note', caption).textContent = spec.caption.note;
  }

  function placeStill() {
    if (!geo || !run) return;
    for (const b of run.balls) {
      b.node.style.transform = `translate(${geo.cx + b.fx - geo.d / 2}px, ${geo.cy + b.fy - geo.d / 2}px)`;
      b.num.style.transform = '';
      if (!run.reduced) b.node.style.opacity = '1';
    }
  }

  function startLoop() {
    if (raf) return;
    lastNow = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(64, Math.max(1, now - lastNow));
    lastNow = now;
    let busy = false;
    if (run && geo) {
      if (run.phase === 'burst' || run.phase === 'flight') busy = flightFrame(now) || busy;
      else if (run.phase === 'exit') busy = exitFrame(now) || busy;
    }
    const inked = opts.particles > 0 ? fx.step(dt, now) : false;
    if (busy || inked) raf = requestAnimationFrame(frame);
    else if (!run || run.phase === 'idle' || run.phase === 'hold') fx.clear();
  }

  function flightFrame(now) {
    const t = (now - run.t0) * run.speed;
    if (run.phase === 'burst' && t >= TIMING.launch) {
      emit('flight');
      if (opts.particles > 0) fx.burst(geo.cx, geo.cy, run.burstCount, run.dir, geo.d * 1.6);
    }
    const { d, cx, cy } = geo;
    for (const b of run.balls) {
      const p = clamp01((t - TIMING.launch) / b.dur);
      if (p <= 0) continue;
      const e = 1 - (1 - p) ** b.k;
      const wave = Math.sin(Math.PI * p);
      const r = b.R * e * (1 + b.over * wave) + b.bulge * d * wave ** 1.3;
      const phi = b.phi - run.dir * b.sweep * (1 - p) ** b.ka;
      // own lateral drift (perpendicular to the radius) — every ball flies its own line
      const lat = b.wob * d * wave * wave;
      const x = Math.cos(phi) * r - Math.sin(phi) * lat;
      const y = Math.sin(phi) * r + Math.cos(phi) * lat;
      let s = 0.2 + 0.8 * easeOutBack(clamp01(p * 1.12), 1.1);
      if (b.extra) s *= 1 + 0.16 * wave;
      if (p >= 1) {
        const tau = (t - TIMING.launch - b.dur) / 1000;
        s *= 1 + 0.035 * Math.exp(-8 * tau) * Math.sin(19 * tau);
        if (!b.landed) {
          b.landed = true;
          if (opts.particles > 0) fx.sparkle(cx + x, cy + y, 4, b.extra ? 3 : 1, d * 0.55);
        }
      }
      const px = cx + x; const py = cy + y;
      if (opts.particles > 0 && b.px !== undefined && p < 0.97) {
        fx.trail(b.px, b.py, px, py, d * s * 0.34, b.extra ? run.trailExtra : run.trailMain, 0.2 * (1 - p) ** 0.6);
        b.wakeAt = (b.wakeAt || 0) - 1;
        if (p < 0.6 && b.wakeAt <= 0) { b.wakeAt = 4; fx.sparkle(px, py, 1, 0, d * 0.25); }
      }
      b.px = px; b.py = py;
      b.node.style.opacity = String(clamp01(p * 7));
      b.node.style.transform = `translate3d(${px - d / 2}px, ${py - d / 2}px, 0) scale(${s.toFixed(4)})`;
      b.num.style.transform = `rotate(${(run.dir * b.spin * (1 - p) ** 2.4).toFixed(2)}deg)`;
    }
    if (t >= TIMING.launch + run.maxDur + TIMING.settle) enterHold();
    return true;
  }

  function enterHold() {
    layer.classList.remove('is-moving');
    placeStill();
    emit('hold');
    stage.setAttribute('aria-label', run.spec.label || '');
    const hold = run.holdMs;
    if (Number.isFinite(hold)) run.holdTimer = setTimeout(() => enterExit(), hold / run.speed);
  }

  function enterExit() {
    if (!run || (run.phase !== 'hold')) return;
    clearTimeout(run.holdTimer);
    run.exitT0 = performance.now();
    for (const b of run.balls) { b.exitDelay = rand(0, 110); b.burst = false; }
    layer.classList.add('is-moving');
    emit('exit');
    const dur = (TIMING.exit + 120) / run.speed;
    run.anims.push(flare.animate([{ opacity: getComputedStyle(flare).opacity }, { opacity: 0 }], { duration: dur, easing: 'ease-in', fill: 'forwards' }));
    run.anims.push(halo.animate([{ opacity: getComputedStyle(halo).opacity }, { opacity: 0 }], { duration: dur * 1.1, easing: 'ease-in', fill: 'forwards' }));
    run.anims.push(swirlWrap.animate([{ opacity: getComputedStyle(swirlWrap).opacity }, { opacity: 0 }], { duration: dur, easing: 'ease-in', fill: 'forwards' }));
    startLoop();
  }

  function exitFrame(now) {
    const t = (now - run.exitT0) * run.speed;
    const { d, cx, cy } = geo;
    let done = true;
    for (const b of run.balls) {
      const q = clamp01((t - b.exitDelay) / TIMING.exit);
      if (q < 1) done = false;
      const e = q * q * (3 - 2 * q);
      const r = (b.R || d * 0.6) * (1 + 0.2 * e) + (b.R ? 0 : d * 0.9 * e);
      const phi = b.phi + run.dir * 0.42 * e;
      const x = cx + Math.cos(phi) * r; const y = cy + Math.sin(phi) * r - d * 0.12 * e;
      b.node.style.opacity = String((1 - q) ** 1.5);
      b.node.style.transform = `translate3d(${x - d / 2}px, ${y - d / 2}px, 0) scale(${(1 - 0.2 * e).toFixed(4)})`;
      if (!b.burst && q > 0.42) {
        b.burst = true;
        if (opts.particles > 0) fx.sparkle(x, y, 5, b.extra ? 3 : 1, d * 0.5);
      }
    }
    if (done && t > TIMING.exit + 130) { finish(); return false; }
    return true;
  }

  function finish() {
    if (!run) return;
    const r = run;
    clearTimeout(r.holdTimer);
    for (const a of r.anims) { try { a.cancel(); } catch (_e) { /* already gone */ } }
    r.anims.length = 0;
    layer.classList.remove('is-moving');
    layer.replaceChildren();
    emit('idle');
    run = null;
    r.resolve({ interrupted: false });
    // the canvas keeps its last sparks; frame() clears it once they have faded
  }

  /** Tears the current run down completely (nodes, timers, animations, canvas). */
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    fx.clear();
    if (!run) return;
    const r = run;
    clearTimeout(r.holdTimer);
    for (const a of r.anims) { try { a.cancel(); } catch (_e) { /* already gone */ } }
    r.anims.length = 0;
    layer.classList.remove('is-moving');
    layer.replaceChildren();
    run = null;
    stage.dataset.phase = 'idle';
    r.resolve({ interrupted: true });
  }

  function playReduced() {
    emit('hold');
    stage.setAttribute('aria-label', run.spec.label || '');
    placeStill();
    const fade = TIMING.reducedFade;
    for (const b of run.balls) {
      run.anims.push(b.node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, easing: 'ease-out', fill: 'forwards' }));
    }
    run.anims.push(flare.animate([{ opacity: 0 }, { opacity: 0.42 }], { duration: fade, fill: 'forwards' }));
    run.anims.push(halo.animate([{ opacity: 0 }, { opacity: 0.7 }], { duration: fade, fill: 'forwards' }));
    const out = () => {
      if (!run) return;
      run.phase = 'exit';
      stage.dataset.phase = 'exit';
      const anims = [...run.balls.map((b) => b.node), flare, halo].map((n) => n.animate([{ opacity: getComputedStyle(n).opacity }, { opacity: 0 }], { duration: fade, easing: 'ease-in', fill: 'forwards' }));
      run.anims.push(...anims);
      anims[0].finished.then(() => { if (run && run.phase === 'exit') finish(); }, () => {});
    };
    if (Number.isFinite(run.holdMs)) run.holdTimer = setTimeout(out, run.holdMs * 1.15);
    run.release = out;
  }

  /**
   * Plays one combination.
   * spec = { theme:{--tokens}, main:number[], extras:{value,kind,poolId}[], caption?:{title,legend,note}, label?:string }
   * Resolves when the run ends ({interrupted:false}) or is replaced/stopped ({interrupted:true}).
   */
  function play(spec, o = {}) {
    if (destroyed) return Promise.resolve({ interrupted: true });
    stop();
    const speed = Math.max(0.1, Number(o.speed ?? opts.speed) || 1);
    const rm = o.reducedMotion ?? opts.reducedMotion;
    const reduced = rm === 'auto' ? prefersReducedMotion() : !!rm;
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    applyTheme(spec.theme);
    stage.classList.toggle('txt-dark-main', isDarkText(spec.theme['--gm-txt']));
    stage.classList.toggle('txt-dark-bonus', isDarkText(spec.theme['--gb-txt']));
    stage.classList.toggle('is-reduced', reduced);
    const { balls, plusNode } = buildBalls(spec);
    buildCaption(spec);
    stage.removeAttribute('aria-label');
    run = {
      spec, balls, plusNode, speed, reduced, resolve, anims: [], holdTimer: 0, phase: 'burst',
      layout: o.layout ?? opts.layout, holdMs: o.holdMs ?? opts.holdMs,
      dir: Math.random() < 0.5 ? -1 : 1,
      trailMain: spec.theme['--gm-hi'], trailExtra: spec.theme['--gb-hi'] || spec.theme['--gm-hi'],
    };
    measure();
    relayout();
    if (reduced) { playReduced(); return done; }

    let maxDur = 0;
    for (const b of balls) {
      b.dur = TIMING.flight * rand(0.84, 1.1);
      b.k = rand(2.3, 3.9);
      b.ka = rand(1.8, 2.8);
      b.sweep = TAU * rand(0.62, 1.32);
      b.spin = rand(280, 680);
      b.over = rand(0.03, 0.11);
      b.wob = rand(-0.45, 0.45);
      b.bulge = b.extra ? rand(1.3, 1.9) : rand(-0.12, 0.5);
      b.node.style.opacity = '0';
      b.node.style.transform = `translate3d(${geo.cx - geo.d / 2}px, ${geo.cy - geo.d / 2}px, 0) scale(0.2)`;
      maxDur = Math.max(maxDur, b.dur);
    }
    run.maxDur = maxDur;
    run.burstCount = Math.round(Math.min(64, Math.max(14, Math.sqrt(W * H) / 13)) * opts.particles);
    layer.classList.add('is-moving');

    const total = (TIMING.launch + maxDur + TIMING.settle) / speed;
    const dir = run.dir;
    const rot = (deg) => `translate(-50%,-50%) rotate(${deg}deg) scaleX(${dir})`;
    run.anims.push(flare.animate([
      { opacity: 0, transform: 'translate(-50%,-50%) scale(.12)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1.3)', offset: 0.09 },
      { opacity: 0.85, transform: 'translate(-50%,-50%) scale(1.05)', offset: 0.3 },
      { opacity: 0.62, transform: 'translate(-50%,-50%) scale(.98)', offset: 0.6 },
      { opacity: 0.44, transform: 'translate(-50%,-50%) scale(1)' },
    ], { duration: total, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' }));
    run.anims.push(halo.animate([
      { opacity: 0, transform: 'translate(-50%,-50%) scale(.4)' },
      { opacity: 0.95, transform: 'translate(-50%,-50%) scale(1.05)', offset: 0.35 },
      { opacity: 0.68, transform: 'translate(-50%,-50%) scale(1)' },
    ], { duration: total, easing: 'ease-out', fill: 'forwards' }));
    run.anims.push(swirl.animate([
      { opacity: 0, transform: rot(-dir * 300) + ' scale(.25)' },
      { opacity: 0.95, transform: rot(-dir * 150) + ' scale(.8)', offset: 0.22 },
      { opacity: 0.32, transform: rot(0) + ' scale(1)' },
    ], { duration: total, easing: 'cubic-bezier(.15,.7,.25,1)', fill: 'forwards' }));
    swirlWrap.style.opacity = '1';
    run.anims.push(swirlWrap.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${dir * 360}deg)` }], { duration: 48000, iterations: Infinity }));

    run.t0 = performance.now();
    emit('burst');
    startLoop();
    return done;
  }

  return {
    play,
    stop,
    /** Ends a held composition now (or immediately after the flight if still flying). */
    release() {
      if (!run) return;
      if (run.reduced) { clearTimeout(run.holdTimer); run.release?.(); return; }
      if (run.phase === 'hold') enterExit();
      else run.holdMs = 0;
    },
    get phase() { return run ? run.phase : 'idle'; },
    get looping() { return raf !== 0; },
    get particleCount() { return fx.ps.length; },
    get layout() { return geo ? { ...geo, pts: geo.pts.map((p) => ({ ...p })) } : null; },
    get stage() { return stage; },
    destroy() {
      stop();
      destroyed = true;
      ro.disconnect();
      stage.remove();
    },
  };
}
