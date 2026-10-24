import { readFile } from 'node:fs/promises';
import express from 'express';
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';

/** Local lab UI only. Never install this plugin in a company Backstage instance. */
export function createDemoPlugin(options: { backendUrl: string; token: string }) {
  return createBackendPlugin({
    pluginId: 'genesismesh-demo',
    register(env) {
      env.registerInit({
        deps: { httpRouter: coreServices.httpRouter },
        async init({ httpRouter }) {
          const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
          const script = await readFile(new URL('./demo.js', import.meta.url), 'utf8');
          const router = express.Router();
          router.use(express.json({ limit: '2kb' }));
          router.get('/', (_req, res) => res.type('html').send(html));
          router.get('/demo.js', (_req, res) => res.type('application/javascript').send(script));
          router.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'local-demo' }));
          router.post('/runs', async (req, res, next) => {
            try {
              if (req.get('origin') !== options.backendUrl || !req.is('application/json')) {
                res.status(403).json({ error: 'Use the local demo page to submit requests.' });
                return;
              }
              const lifetimeDays = req.body.lifetimeDays;
              if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 365) {
                res.status(400).json({ error: 'Lifetime must be an integer from 1 to 365.' });
                return;
              }
              const response = await fetch(`${options.backendUrl}/api/scaffolder/v2/tasks`, {
                method: 'POST', headers: {
                  authorization: `Bearer ${options.token}`, 'content-type': 'application/json',
                },
                body: JSON.stringify({ templateRef: 'template:default/genesismesh-demo-rotation', values: { lifetimeDays } }),
              });
              if (!response.ok) {
                res.status(502).json({ error: 'Backstage could not create the task. Check the local backend log.' });
                return;
              }
              res.status(201).json(await response.json());
            } catch (error) { next(error); }
          });
          router.get('/runs/:id', async (req, res, next) => {
            try {
              if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.params.id)) { res.sendStatus(400); return; }
              const headers = { authorization: `Bearer ${options.token}` };
              const task = await fetch(`${options.backendUrl}/api/scaffolder/v2/tasks/${req.params.id}`, { headers });
              const events = await fetch(`${options.backendUrl}/api/scaffolder/v2/tasks/${req.params.id}/events`, { headers });
              if (!task.ok || !events.ok) { res.sendStatus(502); return; }
              const data = await task.json() as { status: string };
              res.json({ id: req.params.id, status: data.status, events: await events.json() });
            } catch (error) { next(error); }
          });
          httpRouter.addAuthPolicy({ path: '/', allow: 'unauthenticated' });
          httpRouter.use(router);
        },
      });
    },
  });
}
