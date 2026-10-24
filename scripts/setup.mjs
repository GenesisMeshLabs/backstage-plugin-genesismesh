import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) { console.error('Setup failed. Python 3.12 or newer is required.'); process.exit(1); }
}
if (!existsSync(python)) run(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', '.venv']);
run(python, ['-m', 'pip', 'install', '-r', 'requirements-local.txt']);
console.log('Local Python environment ready. Run npm run local:start or npm run test:integration.');
