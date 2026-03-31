const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

async function checkQdrant() {
  const url = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
  const enabled = process.env.QDRANT_ENABLED === '0' ? false : true;
  if (!enabled) {
    return { ok: true, detail: 'disabled by QDRANT_ENABLED=0; vectra fallback will be used' };
  }
  try {
    const response = await fetch(`${url}/collections`);
    if (response.ok) {
      return { ok: true, detail: `reachable at ${url}` };
    }
    return { ok: false, detail: `responded with HTTP ${response.status} at ${url}` };
  } catch (e) {
    return { ok: false, detail: `not reachable at ${url}; vectra fallback will be used` };
  }
}

function printCheck(label, ok, detail) {
  console.log(`[${ok ? 'OK  ' : 'WARN'}] ${label} - ${detail}`);
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
  printCheck('Node.js', nodeMajor >= 18, `detected ${process.versions.node}, recommended >= 18`);
  printCheck('Root node_modules', exists('node_modules'), exists('node_modules') ? 'installed' : 'missing; run `npm run setup`');
  printCheck('Server node_modules', exists('server/node_modules'), exists('server/node_modules') ? 'installed' : 'missing; run `npm run setup`');
  printCheck('Client node_modules', exists('client/node_modules'), exists('client/node_modules') ? 'installed' : 'missing; run `npm run setup`');
  printCheck('Data directory', exists('data'), exists('data') ? 'present' : 'missing; it will be created automatically');
  printCheck('Uploads directory', exists('server/public/uploads'), exists('server/public/uploads') ? 'present' : 'missing; it will be created automatically');
  printCheck('Server env file', exists('server/.env'), exists('server/.env') ? 'present' : 'missing; copy from server/.env.example if you need fixed local defaults');

  const qdrant = await checkQdrant();
  printCheck('Qdrant', qdrant.ok, qdrant.detail);

  console.log('\n[doctor] Fresh clones can still run without Qdrant.');
  console.log('[doctor] SQLite, auth DB, uploads, vectra indices, and cache directories are auto-created on first start.');
}

main().catch((error) => {
  console.error('[doctor] Failed:', error.message);
  process.exit(1);
});
