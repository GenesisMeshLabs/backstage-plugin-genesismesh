import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLocalSecretAdapter } from '../src/localSecretAdapter.js';

test('a retried task cannot rotate the resource twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'genesismesh-backstage-test-'));
  try {
    const adapter = createLocalSecretAdapter(directory);
    const first = await adapter.rotate({ lifetimeDays: 7, operationId: 'same-task' });
    const state = await readFile(join(directory, 'demo-secret.json'), 'utf8');
    await assert.rejects(adapter.rotate({ lifetimeDays: 7, operationId: 'same-task' }), /cannot start another rotation/);
    assert.equal(await readFile(join(directory, 'demo-secret.json'), 'utf8'), state);
    const persisted = JSON.parse(state);
    assert.equal(first.version, persisted.version);
    assert.equal('value' in first, false);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'genesismesh-backstage-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});
