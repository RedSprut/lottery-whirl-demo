#!/usr/bin/env node
/**
 * Local preview server for the Lottery Whirl demo (the public copy is served by GitHub Pages).
 *
 *   node serve.mjs            → http://localhost:5317/
 *   node serve.mjs --lan      → also reachable from a phone on the same Wi-Fi
 *   node serve.mjs --port=6000
 *
 * Serves the static files of this repository only (no dotfiles, no parent directories).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

export function createStandServer() {
  return http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    if (pathname.includes('..') || /\/\./.test(pathname) || !TYPES[path.extname(pathname)]) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    try {
      const body = await fs.readFile(path.join(ROOT, pathname));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(pathname)], 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lan = process.argv.includes('--lan');
  const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 5317;
  createStandServer().listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Lottery Whirl demo: http://localhost:${port}/`);
    if (lan) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on this Wi-Fi:      http://${a.address}:${port}/`);
      }
    }
    console.log('Ctrl+C to stop.');
  });
}
