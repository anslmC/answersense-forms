import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(packageRoot, 'dist');
const viteBin = [
  resolve(packageRoot, 'node_modules/vite/bin/vite.js'),
  resolve(packageRoot, '..', 'node_modules/vite/bin/vite.js'),
].find((candidate) => existsSync(candidate));

if (!viteBin) {
  console.error('[dev] Unable to locate the local Vite executable.');
  process.exit(1);
}

const watchers = new Map();
let shuttingDown = false;

rmSync(distDir, { recursive: true, force: true });

function forward(stream, target, label) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) target.write(`[${label}] ${pending}\n`);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const watcher of watchers.values()) watcher.kill();
  setTimeout(() => process.exit(code), 500).unref();
}

function startWatcher(label, mode) {
  const watcher = spawn(
    process.execPath,
    [viteBin, 'build', '--watch', '--mode', mode],
    {
      cwd: packageRoot,
      env: { ...process.env, ANSWERSENSE_DEV_WATCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  forward(watcher.stdout, process.stdout, label);
  forward(watcher.stderr, process.stderr, label);
  watchers.set(label, watcher);

  watcher.on('error', (error) => {
    console.error(`[${label}] watcher failed to start: ${error.message}`);
    shutdown(1);
  });
  watcher.on('exit', (code) => {
    watchers.delete(label);
    if (shuttingDown) return;
    console.error(
      `[${label}] watcher exited unexpectedly with code ${code ?? 1}.`
    );
    shutdown(code ?? 1);
  });

  return watcher;
}

async function waitForFirstBuild(watcher, file) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    if (watcher.exitCode !== null) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const backgroundWatcher = startWatcher('background', 'extension');
const backgroundBuilt = await waitForFirstBuild(
  backgroundWatcher,
  resolve(distDir, 'background/background.js')
);
if (!backgroundBuilt) {
  console.error(
    '[dev] The background bundle was not produced; starting the content watcher anyway.'
  );
}
startWatcher('content', 'content');
