const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const children = [];

function fileExists(filePath) {
  try {
    return require('fs').existsSync(filePath);
  } catch (e) {
    return false;
  }
}

function getBundledNode() {
  const candidate = isWindows
    ? path.join(root, '.runtime', 'node20', 'node.exe')
    : path.join(root, '.runtime', 'node20', 'bin', 'node');
  return fileExists(candidate) ? candidate : '';
}

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!text || /\s|"/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return text;
}

function startProcess(name, command, args, cwd, options = {}) {
  const useShell = options.shell ?? (isWindows && String(command).toLowerCase().endsWith('.cmd'));
  const spawnTarget = isWindows && useShell
    ? [ `${quoteWindowsArg(command)} ${args.map(quoteWindowsArg).join(' ')}`, [] ]
    : [ command, args ];

  const child = spawn(spawnTarget[0], spawnTarget[1], {
    cwd,
    stdio: 'inherit',
    // On Windows, npm is a .cmd wrapper and should be spawned via a shell.
    shell: useShell,
    windowsHide: true,
    env: { ...process.env }
  });

  child.on('error', (error) => {
    console.error(`[dev] failed to start ${name}: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });

  children.push(child);
}

function startNodeProcess(name, args, cwd) {
  const bundledNode = getBundledNode();
  if (!bundledNode) return false;

  console.log(`[dev] starting ${name} with bundled Node: ${bundledNode}`);
  startProcess(name, bundledNode, args, cwd, { shell: false });
  return true;
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(exitCode);
}

if (!startNodeProcess('server', ['index.js'], path.join(root, 'server'))) {
  startProcess('server', npmCmd, ['run', 'start'], path.join(root, 'server'));
}

const viteEntry = path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
if (!startNodeProcess('client', [viteEntry, '--host', '127.0.0.1', '--port', '5173'], path.join(root, 'client'))) {
  startProcess('client', npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], path.join(root, 'client'));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
