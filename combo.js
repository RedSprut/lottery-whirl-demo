/**
 * Lottery Whirl — combination generator (EXPERIMENTAL prototype, not wired into the app).
 *
 * Rules come from the ONE registry the app and the 3D drum already share:
 * demo-drum/src/registry.js (CANONICAL_GAMES, verified against the operators and held
 * in parity with index.html's LOTTERY_CONFIG by scripts/audit-drum-games.mjs on every
 * build). Nothing here restates a range or a count.
 *
 * The only addition is SuperEnalotto's SuperStar: the registry models the drum's
 * 6 + Jolly draw, while the app's history shows the official SuperStar after the Jolly
 * (index.html `.hball.superstar`, «Отдельный барабан 1–90»). It is an extra of its own,
 * drawn from a separate 1–90 drum, so it MAY coincide with a main number or the Jolly.
 *
 * Every call builds fresh pools and draws from crypto.getRandomValues — no stored or
 * pre-recorded sequences, no seed, no sorting: numbers keep their draw order.
 * Combinations are demonstrations only — never official results, never predictions.
 */
import { CANONICAL_GAMES } from './vendor/registry.js';

export const GAMES = CANONICAL_GAMES;
export const GAME_IDS = CANONICAL_GAMES.map((g) => g.id);

/** Separate-drum add-ons the registry does not model (see header). */
export const ADDONS = {
  superEnalotto: [{ poolId: 'superstar', label: 'SuperStar', max: 90, draw: 1, strategy: 'separate-pool' }],
};

export function gameById(id) {
  const g = CANONICAL_GAMES.find((x) => x.id === id);
  if (!g) throw new RangeError(`unknown_game:${id}`);
  return g;
}

const U32 = 0x100000000;

/** Uniform integer in [0, n) — rejection sampling, so no modulo bias. */
export function randomIndex(n) {
  if (!Number.isInteger(n) || n < 1 || n > U32) throw new RangeError(`bad_bound:${n}`);
  const buf = new Uint32Array(1);
  const limit = U32 - (U32 % n);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}

const pool = (max) => Array.from({ length: max }, (_, i) => i + 1);

/** Draws k balls from `balls` WITHOUT replacement (partial Fisher–Yates); removes them. */
function drawFrom(balls, k) {
  if (k > balls.length) throw new RangeError('pool_exhausted');
  for (let i = 0; i < k; i++) {
    const j = i + randomIndex(balls.length - i);
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls.splice(0, k);
}

/**
 * A fresh demonstration combination for one game, in draw order.
 * @returns {{gameId:string, main:number[], extras:{poolId:string,label:string,value:number,kind:'bonus'|'addon',strategy:string}[]}}
 */
export function generateCombination(gameId) {
  const g = gameById(gameId);
  const mainDrum = pool(g.main.max);
  const main = drawFrom(mainDrum, g.main.draw);
  const extras = [];
  if (g.bonus) {
    // same-main-pool: the next ball(s) out of the SAME drum, so never equal to a main number.
    // separate-pool: its own freshly loaded drum, independent of the main draw.
    const drum = g.bonus.strategy === 'same-main-pool' ? mainDrum : pool(g.bonus.max);
    for (const value of drawFrom(drum, g.bonus.draw)) {
      extras.push({ poolId: g.bonus.poolId, labelKey: g.bonus.labelKey, value, kind: 'bonus', strategy: g.bonus.strategy });
    }
  }
  for (const add of ADDONS[g.id] || []) {
    for (const value of drawFrom(pool(add.max), add.draw)) {
      extras.push({ poolId: add.poolId, label: add.label, value, kind: 'addon', strategy: add.strategy });
    }
  }
  return { gameId: g.id, main, extras };
}

/** Human rule line, built from the registry (Russian stand copy). */
export function ruleLine(gameId, labelOf) {
  const g = gameById(gameId);
  const parts = [`${g.main.draw} из 1–${g.main.max}`];
  if (g.bonus) {
    const where = g.bonus.strategy === 'same-main-pool' ? 'из того же барабана' : `из 1–${g.bonus.max}, отдельный барабан`;
    parts.push(`${g.bonus.draw} ${labelOf(g.bonus)} ${where}`);
  }
  for (const add of ADDONS[g.id] || []) parts.push(`${add.draw} ${add.label} из 1–${add.max}, отдельный барабан`);
  return parts.join(' + ');
}
