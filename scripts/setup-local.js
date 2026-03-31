const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function ensureEnvFile() {
  const source = path.join(root, 'server', '.env.example');
  const target = path.join(root, 'server', '.env');
  if (!fileExists(source) || fileExists(target)) return;
  fs.copyFileSync(source, target);
  console.log('[setup] Created server/.env from server/.env.example');
}

function main() {
  console.log('[setup] Preparing local workspace...');

  ensureDir(path.join(root, '.runtime'));
  ensureDir(path.join(root, 'data'));
  ensureDir(path.join(root, 'server', 'public', 'uploads'));
  ensureEnvFile();

  console.log('[setup] Installing root dependencies...');
  run(npmCmd, ['install'], root);

  console.log('[setup] Installing server dependencies...');
  run(npmCmd, ['install'], path.join(root, 'server'));

  console.log('[setup] Installing client dependencies...');
  run(npmCmd, ['install'], path.join(root, 'client'));

  console.log('[setup] Done.');
  console.log('[setup] Next steps:');
  console.log('  1. Review server/.env and set ADMIN_PASSWORD plus any model/Qdrant overrides you want.');
  console.log('  2. Start the app with `npm run dev` or use `start-stack.cmd` on Windows.');
  console.log('  3. If Qdrant is running and you imported existing memories, run `npm run migrate:qdrant`.');
}

main();
