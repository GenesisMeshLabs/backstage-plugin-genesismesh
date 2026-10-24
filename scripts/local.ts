import { startLab } from './lab.js';

const lab = await startLab({ demo: true });
console.log(`Local Backstage demo: ${lab.demoUrl}`);
console.log(`Fresh isolated state: ${lab.stateDirectory}`);
console.log('Press Ctrl+C to stop both local services.');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await lab.stop(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of [lab.backend, lab.authority]) child.on('exit', () => { if (!stopping) void stop(); });
