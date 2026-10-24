import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createBackend } from '@backstage/backend-defaults';
import { coreServices, createServiceFactory } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import genesisMeshModule from '../src/index.js';
import { createDemoPlugin } from './demoPlugin.js';
import type { BackendFeature } from '@backstage/backend-plugin-api';

const runtimeFile = process.env.GM_LOCAL_RUNTIME;
if (!runtimeFile) throw new Error('Use npm run local:start to prepare the isolated local runtime.');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
const backendUrl = `http://127.0.0.1:${runtime.backendPort}`;
const backend = createBackend();
backend.add(createServiceFactory({
  service: coreServices.rootConfig,
  deps: {},
  factory: async () => new ConfigReader({
    app: { title: 'Genesis Mesh local integration', baseUrl: backendUrl },
    backend: {
      baseUrl: backendUrl,
      listen: { host: '127.0.0.1', port: runtime.backendPort },
      database: { client: 'better-sqlite3', connection: ':memory:' },
      auth: { externalAccess: [{ type: 'static', options: {
        token: runtime.token, subject: 'genesismesh-local-lab',
      }, accessRestrictions: [{ plugin: 'catalog' }, { plugin: 'scaffolder' }] }] },
    },
    catalog: {
      rules: [{ allow: ['Template', 'Component', 'User', 'Group'] }],
      locations: [{ type: 'file', target: runtime.templateFile }],
    },
    scaffolder: { concurrentTasksLimit: 1 },
    genesismesh: {
      connectionFile: runtime.connectionFile,
      stateDirectory: runtime.pluginStateDirectory,
      localDemo: { enabled: true, allowServiceInitiators: true },
    },
  }),
}));
// Backstage publishes these plugins as CommonJS; unwrap its exported feature.
const require = createRequire(import.meta.url);
for (const name of ['@backstage/plugin-catalog-backend',
  '@backstage/plugin-catalog-backend-module-scaffolder-entity-model',
  '@backstage/plugin-scaffolder-backend']) {
  backend.add(require(name).default as BackendFeature);
}
backend.add(genesisMeshModule);
backend.add(createDemoPlugin({ backendUrl, token: runtime.token }));
try { await backend.start(); } catch { process.exit(1); }
