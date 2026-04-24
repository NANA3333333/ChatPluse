const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const children = [];

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!text || /\s|"/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return text;
}

function startProcess(name, command, args, cwd) {
  const spawnTarget = isWindows
    ? [ `${command} ${args.map(quoteWindowsArg).join(' ')}`, [] ]
    : [ command, args ];

  const child = spawn(spawnTarget[0], spawnTarget[1], {
    cwd,
    stdio: 'inherit',
    // On Windows, npm is a .cmd wrapper and should be spawned via a shell.
    shell: isWindows,
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

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(exitCode);
}

startProcess('server', npmCmd, ['run', 'start'], path.join(root, 'server'));
startProcess('client', npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], path.join(root, 'client'));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
