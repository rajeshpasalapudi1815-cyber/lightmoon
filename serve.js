// Optional: serves the Vega app from this computer at http://localhost:3000.
// Not needed on your phone, which uses the published link instead.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return res.writeHead(400).end();
  }
  const file = path.join(APP_DIR, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  if (!file.startsWith(APP_DIR + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
});

const url = `http://localhost:${PORT}`;
const openBrowser = () => {
  const command = { win32: `start "" "${url}"`, darwin: `open "${url}"` }[process.platform] ?? `xdg-open "${url}"`;
  exec(command, () => {});
};

server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use; Vega may already be running at ${url}.`);
  if (process.argv.includes('--open')) openBrowser();
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Vega is running at ${url}\n  Press Ctrl+C to stop.\n`);
  if (process.argv.includes('--open')) openBrowser();
});
