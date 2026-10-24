import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GenesisMeshClient, parseExportLines, verifyEvidenceEvents } from 'genesis-mesh-sdk';
import { startLab, stopProcess, delay, projectRoot } from './lab.js';
import { parseConnection } from '../src/connection.js';

const checks: string[] = [];
const lab = await startLab();
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function task(lifetimeDays: number) {
  const response = await fetch(`${lab.backendUrl}/api/scaffolder/v2/tasks`, {
    method: 'POST', headers: lab.headers,
    body: JSON.stringify({ templateRef: 'template:default/genesismesh-demo-rotation', values: { lifetimeDays } }),
  });
  assert.equal(response.status, 201, `Task creation failed (${response.status})`);
  const { id } = await response.json() as { id: string };
  for (let tries = 0; tries < 160; tries++) {
    const taskResponse = await fetch(`${lab.backendUrl}/api/scaffolder/v2/tasks/${id}`, { headers: lab.headers });
    assert.equal(taskResponse.status, 200);
    const body = await taskResponse.json() as { status: string };
    if (body.status === 'completed' || body.status === 'failed') {
      const events = await fetch(`${lab.backendUrl}/api/scaffolder/v2/tasks/${id}/events`, { headers: lab.headers });
      return { id, status: body.status, events: await events.json() };
    }
    await delay(250);
  }
  throw new Error('Task completion timeout.');
}
async function state() { return readFile(join(lab.pluginStateDirectory, 'demo-secret.json'), 'utf8'); }
try {
  const unauthenticated = await fetch(`${lab.backendUrl}/api/scaffolder/v2/actions`);
  assert.equal(unauthenticated.status, 401);
  check('Backstage rejects unauthenticated Scaffolder requests');
  const actions = await fetch(`${lab.backendUrl}/api/scaffolder/v2/actions`, { headers: lab.headers });
  assert.equal(actions.status, 200);
  assert.ok((await actions.json() as { id: string }[]).some(action => action.id === 'genesismesh:demoSecret:rotate'));
  check('Genesis Mesh action registered in the real Backstage Scaffolder');

  const allowed = await task(7);
  assert.equal(allowed.status, 'completed', JSON.stringify(allowed.events));
  const firstState = await state();
  const secret = JSON.parse(firstState);
  assert.ok(secret.version && secret.value);
  check('ALLOW creates a local secret version through a real Scaffolder task');
  const denied = await task(90);
  assert.equal(denied.status, 'failed');
  assert.match(JSON.stringify(denied.events), /denied this request/);
  assert.equal(await state(), firstState);
  check('Policy DENY leaves the secret unchanged');

  const setup = new GenesisMeshClient({ baseUrl: lab.fixture.baseUrl, signingKeyBase64: lab.fixture.setup.seedBase64,
    keyId: lab.fixture.setup.keyId, audience: lab.fixture.naPublicKey });
  const naKeys = await setup.na.verifiedKeyHistory(lab.fixture.naPublicKey);
  const events = parseExportLines(await setup.evidenceStore.exportText({ limit: 1000 }));
  const verified = verifyEvidenceEvents(events, { naPublicKeys: naKeys, executorKeys: await setup.evidenceStore.listExecutorKeys() });
  assert.equal(verified.verified, true, JSON.stringify(verified.failures));
  check('Execution and decision evidence verifies offline against the pinned root');

  const tampered = structuredClone(lab.fixture);
  tampered.policy.policy_id = 'tampered-policy';
  assert.throws(() => parseConnection(tampered), /Invalid Genesis Mesh/);
  check('Tampered policy fixture is rejected');
  const parsed = parseConnection(lab.fixture);
  assert.equal('setup' in parsed, false);
  const pluginFixture = JSON.parse(await readFile(lab.connectionFile, 'utf8'));
  assert.equal('setup' in pluginFixture, false);
  check('Privileged setup credentials are excluded from plugin configuration');

  await setup.attestation.revoke(lab.fixture.attestation.attestation_id);
  const revoked = await task(7);
  assert.equal(revoked.status, 'failed');
  assert.equal(await state(), firstState);
  check('Revocation blocks a previously permitted operation');

  await stopProcess(lab.authority);
  const unavailable = await task(7);
  assert.equal(unavailable.status, 'failed');
  assert.match(JSON.stringify(unavailable.events), /unavailable/);
  assert.equal(await state(), firstState);
  check('Authority outage fails closed without changing the secret');

  const visible = JSON.stringify([allowed, denied, revoked, unavailable]);
  for (const sensitive of [secret.value, lab.token, lab.fixture.controller.seedBase64,
    lab.fixture.executor.seedBase64, lab.fixture.setup.seedBase64]) {
    assert.ok(!visible.includes(sensitive), 'A credential appeared in task output.');
  }
  check('Task outputs and events exclude secret values and private credentials');
  const report = { completedAt: new Date().toISOString(), checks, result: 'passed',
    scope: 'Real local Backstage and Genesis Mesh; simulated file secret store', stateDirectory: lab.stateDirectory };
  await writeFile(join(projectRoot, '.local/integration-results.json'), JSON.stringify(report, null, 2));
  console.log(`${checks.length} integration checks passed. Report: .local/integration-results.json`);
} finally { await lab.stop(); }
