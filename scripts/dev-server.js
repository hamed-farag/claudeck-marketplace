#!/usr/bin/env node
// Local dev server that mimics Vercel rewrites for testing the showcase.
// Usage: node scripts/dev-server.js

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');
const PORT = process.env.PORT || 3000;
// Bind all interfaces so reverse proxies (Traefik/Dokploy) can reach the
// container. Node's default listen host can resolve to IPv6-only in some
// containers, which the proxy connects past over IPv4. Override with HOST.
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// Rewrite rules (mirrors vercel.json)
function rewrite(url) {
  // Strip query string for file resolution
  const [path] = url.split('?');

  // Mock module rewrites
  if (path === '/js/ui/tab-sdk.js')  return '/showcase/mock/tab-sdk.js';
  if (path === '/js/ui/api.js')      return '/showcase/mock/api.js';
  if (path === '/js/core/utils.js')  return '/showcase/mock/utils.js';
  if (path.startsWith('/js/ui/') && path.endsWith('.js'))   return '/showcase/mock/noop.js';
  if (path.startsWith('/js/core/') && path.endsWith('.js')) return '/showcase/mock/noop.js';

  // Page rewrites
  if (path === '/')         return '/showcase/index.html';
  if (path === '/plugins')  return '/showcase/plugins.html';
  if (path === '/preview')  return '/showcase/preview.html';

  // Gallery JS
  if (path === '/gallery.js') return '/showcase/js/gallery.js';
  if (path === '/home.js')    return '/showcase/js/home.js';

  // CSS & images
  if (path.startsWith('/css/')) return '/showcase' + path;
  if (path.startsWith('/images/')) return '/showcase' + path;

  // Everything else: serve from root
  return path;
}

// API handler (mimics serverless functions)
async function handleApi(url, req, res) {
  const [path] = url.split('?');

  if (path === '/api/registry') {
    const registryMod = await import(join(ROOT, 'api', 'registry.js'));
    // Fake res object for the serverless handler
    const fakeRes = {
      _status: 200,
      _headers: {},
      _body: null,
      status(code) { this._status = code; return this; },
      setHeader(k, v) { this._headers[k] = v; },
      json(data) {
        this._body = JSON.stringify(data);
        res.writeHead(this._status, { 'Content-Type': 'application/json', ...this._headers });
        res.end(this._body);
      },
    };
    // Override process.cwd to return ROOT
    const origCwd = process.cwd;
    process.cwd = () => ROOT;
    try {
      registryMod.default(req, fakeRes);
    } finally {
      process.cwd = origCwd;
    }
    return true;
  }

  // Plugin API routes
  const pluginMatch = path.match(/^\/api\/plugins\/([^/]+)/);
  if (pluginMatch) {
    const name = pluginMatch[1];
    const routeFile = join(ROOT, 'api', 'plugins', `${name}.js`);
    if (existsSync(routeFile)) {
      const mod = await import(routeFile);
      const fakeRes = {
        _status: 200,
        _headers: {},
        status(code) { this._status = code; return this; },
        setHeader(k, v) { this._headers[k] = v; },
        json(data) {
          res.writeHead(this._status, { 'Content-Type': 'application/json', ...this._headers });
          res.end(JSON.stringify(data));
        },
        end() { res.writeHead(this._status, this._headers); res.end(); },
      };
      mod.default(req, fakeRes);
      return true;
    }
  }

  return false;
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';

  // Handle API routes
  if (url.startsWith('/api/')) {
    const handled = await handleApi(url, req, res).catch(err => {
      console.error('API error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return true;
    });
    if (handled) return;
  }

  // Apply rewrites
  const rewritten = rewrite(url);
  const filePath = join(ROOT, rewritten);

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404: ${rewritten}`);
    return;
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
\x1b[36m  Claudeck Marketplace — Dev Server\x1b[0m

  \x1b[1m\x1b[32m➜\x1b[0m  \x1b[1mListening:\x1b[0m ${HOST}:${PORT}
  \x1b[2m➜  Local:\x1b[0m   http://localhost:${PORT}
  \x1b[2m➜  Preview:\x1b[0m http://localhost:${PORT}/preview?plugin=tic-tac-toe
  \x1b[2m➜  API:\x1b[0m    http://localhost:${PORT}/api/registry
`);
});
