import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const python = join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free local port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([stopped, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function startLogged(command: string, args: string[], log: string, env?: NodeJS.ProcessEnv): ChildProcess {
  const descriptor = openSync(log, 'a', 0o600);
  try {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env }, stdio: ['ignore', descriptor, descriptor] });
    child.on('error', () => {}); // Readiness/waiters surface errors without printing credentials.
    return child;
  } finally { closeSync(descriptor); }
}

async function waitFor(url: string, children: ChildProcess[], headers?: Record<string, string>): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('A local service exited before readiness. Inspect its log in the run directory.');
    }
    try { if ((await fetch(url, { headers, signal: AbortSignal.timeout(1_500) })).ok) return; } catch { /* booting */ }
    await delay(300);
  }
  throw new Error(`Local service did not become ready: ${new URL(url).pathname}. Inspect the run logs.`);
}

export async function startLab(options: { demo?: boolean } = {}) {
  const local = join(projectRoot, '.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const stateDirectory = await mkdtemp(join(local, options.demo ? 'demo-' : 'integration-'));
  const authorityDirectory = join(stateDirectory, 'authority');
  const authorityPort = options.demo ? 19443 : await freePort();
  const backendPort = options.demo ? 17007 : await freePort();
  const authorityConnectionFile = join(authorityDirectory, 'connection.json');
  const connectionFile = join(stateDirectory, 'plugin-connection.json');
  const pluginStateDirectory = join(stateDirectory, 'plugin');
  const token = randomBytes(32).toString('hex');
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  let authority: ChildProcess | undefined;
  let backend: ChildProcess | undefined;
  const stop = async () => { await stopProcess(backend); await stopProcess(authority); };
  try {
    authority = startLogged(python, ['scripts/local-authority.py', '--state-dir', authorityDirectory,
      '--port', String(authorityPort)], join(stateDirectory, 'authority.log'));
    await waitFor(`http://127.0.0.1:${authorityPort}/healthz`, [authority]);
    const fixture = JSON.parse(await readFile(authorityConnectionFile, 'utf8'));
    // Keep the privileged bootstrap credential out of the file the plugin reads.
    const { setup: _setup, ...pluginFixture } = fixture;
    await writeFile(connectionFile, JSON.stringify(pluginFixture), { mode: 0o600 });
    const runtime = { backendPort, token, connectionFile, pluginStateDirectory,
      templateFile: resolve(projectRoot, 'examples/template.yaml') };
    const runtimeFile = join(stateDirectory, 'runtime.json');
    await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 });
    backend = startLogged(process.execPath, ['--import', 'tsx', 'dev/backend.ts'], join(stateDirectory, 'backstage.log'),
      { GM_LOCAL_RUNTIME: runtimeFile, NODE_ENV: 'development', LOG_LEVEL: 'warn' });
    await waitFor(`${backendUrl}/api/genesismesh-demo/health`, [authority, backend]);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await waitFor(`${backendUrl}/api/catalog/entities/by-name/template/default/genesismesh-demo-rotation`, [authority, backend], headers);
    return { stateDirectory, pluginStateDirectory, connectionFile, fixture, token, headers, backendUrl,
      authority, backend, stop, demoUrl: `${backendUrl}/api/genesismesh-demo/` };
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : 'Local startup failed'} Logs: ${stateDirectory}`);
  }
}
