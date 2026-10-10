/**
 * Lottery Whirl — per-game palette, lifted from the app.
 *
 * The app's index.html declares every game's brand tokens ONCE, as
 *   body[data-game="viking"],[data-ball-game="viking"]{--hdr-a:…;--gm:…;--gb:…}
 * and maps the registry ids onto those app keys in LOTTERY_APP_KEYS.
 * tools/sync-from-app.mjs runs extractFromIndexHtml() over it and stores only those tokens
 * in vendor/palette.json, so the whirl is painted with exactly the colours the app paints
 * its balls with, without publishing the app.
 *
 * If palette.json cannot be read, the registry's GAME_THEMES (the drum's copy of the same
 * palette) is the fallback; `source` says which one is in use and the test requires
 * 'palette.json'.
 */
import { GAME_THEMES } from './vendor/registry.js';

const TOKEN_NAMES = ['--hdr-a', '--hdr-b', '--hdr-c', '--game-glow', '--gm', '--gm-hi', '--gm-lo', '--gm-txt', '--gb', '--gb-hi', '--gb-lo', '--gb-txt'];

const FALLBACK_APP_KEYS = {
  lotto: 'lotto', vikinglotto: 'viking', eurojackpot: 'euro', powerball: 'powerball', megaMillions: 'mega',
  euroMillions: 'euromillions', superEnalotto: 'superenalotto', lottoMax: 'lottomax', powerballAustralia: 'powerballau',
};

function parseDecls(body) {
  const out = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export function extractFromIndexHtml(html) {
  const appKeys = {};
  const block = /const LOTTERY_APP_KEYS=\{([^}]*)\}/.exec(html);
  if (block) for (const m of block[1].matchAll(/(\w+):'(\w+)'/g)) appKeys[m[1]] = m[2];

  const tokensByAppKey = {};
  for (const m of html.matchAll(/\[data-ball-game="(\w+)"\]\{([^}]*)\}/g)) {
    tokensByAppKey[m[1]] = { ...(tokensByAppKey[m[1]] || {}), ...parseDecls(m[2]) };
  }
  const ss = /\.hball\.superstar\{([^}]*)\}/.exec(html);
  const superstar = ss ? parseDecls(ss[1]) : null;
  return { appKeys, tokensByAppKey, superstar };
}

function fallbackTokens(id) {
  const t = GAME_THEMES[id];
  const mix = (c, w, p) => `color-mix(in srgb, ${c} ${p}%, ${w})`;
  return {
    '--hdr-a': t.primary, '--hdr-b': t.secondary, '--hdr-c': t.accent, '--game-glow': t.glow,
    '--gm': t.ballMain, '--gm-hi': mix(t.ballMain, '#fff', 55), '--gm-lo': mix(t.ballMain, '#000', 55), '--gm-txt': '#fff',
    '--gb': t.ballBonus, '--gb-hi': mix(t.ballBonus, '#fff', 55), '--gb-lo': mix(t.ballBonus, '#000', 55), '--gb-txt': '#fff',
  };
}

const FALLBACK_SUPERSTAR = { '--ball': '#E8B923', '--ball-hi': '#FFE680', '--ball-lo': '#A67C0A', color: '#3a2600' };

/**
 * @returns {Promise<{source:'palette.json'|'fallback', themes:Record<string,Record<string,string>>, appKeys:Record<string,string>, missing:string[]}>}
 * themes[gameId] holds the --hdr/--gm/--gb tokens plus --ss/--ss-hi/--ss-lo/--ss-txt (SuperStar).
 */
export async function loadThemes(gameIds, url = new URL('./vendor/palette.json', import.meta.url)) {
  let parsed = null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) parsed = await res.json();
  } catch (_e) { parsed = null; }

  const themes = {};
  const missing = [];
  const appKeys = { ...FALLBACK_APP_KEYS, ...(parsed?.appKeys || {}) };
  for (const id of gameIds) {
    const fromApp = parsed?.tokensByAppKey[appKeys[id]];
    const complete = fromApp && TOKEN_NAMES.every((k) => fromApp[k]);
    if (!complete) missing.push(id);
    const tokens = complete ? Object.fromEntries(TOKEN_NAMES.map((k) => [k, fromApp[k]])) : fallbackTokens(id);
    const ss = parsed?.superstar || FALLBACK_SUPERSTAR;
    themes[id] = { ...tokens, '--ss': ss['--ball'], '--ss-hi': ss['--ball-hi'], '--ss-lo': ss['--ball-lo'], '--ss-txt': ss.color };
  }
  return { source: parsed && !missing.length && parsed.superstar ? 'palette.json' : 'fallback', themes, appKeys, missing };
}
