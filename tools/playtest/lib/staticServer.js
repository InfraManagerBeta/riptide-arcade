// Minimal static file server, scoped to this tool. Deliberately NOT shared
// with tools/verify/ (t3 owns its own copy there) — see the lane note in the
// t4 work order: duplicating this small helper is the intended trade to keep
// the two ticket's directories merge-conflict-free.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// Serves `rootDir` over 127.0.0.1 on an OS-assigned free port. Games must
// work as-is under a plain static server (no file://, no build step) — this
// is that plain static server, nothing more.
function startStaticServer(rootDir) {
  const absRoot = path.resolve(rootDir);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch (_) {
        urlPath = req.url || '/';
      }
      const safePath = path.normalize(path.join(absRoot, urlPath));
      if (!safePath.startsWith(absRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.stat(safePath, (err, stat) => {
        let filePath = safePath;
        if (!err && stat.isDirectory()) {
          filePath = path.join(safePath, 'index.html');
        }
        fs.readFile(filePath, (readErr, data) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found: ' + urlPath);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        baseUrl,
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

module.exports = { startStaticServer };
