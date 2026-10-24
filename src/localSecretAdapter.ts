import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface RotationMetadata {
  version: string;
  expiresAt: string;
}

export interface SecretRotationAdapter {
  rotate(input: { lifetimeDays: number; operationId: string }): Promise<RotationMetadata>;
}

/**
 * A simulated provider: it persists a random value but grants no cloud access.
 * The lifetime is stored metadata; there is no timer enforcing its expiration.
 * Run one backend process per state directory. Windows inherits directory ACLs.
 */
export function createLocalSecretAdapter(stateDirectory: string): SecretRotationAdapter {
  return {
    async rotate({ lifetimeDays, operationId }) {
      const operations = join(stateDirectory, 'operations');
      await mkdir(operations, { recursive: true, mode: 0o700 });
      const operationKey = createHash('sha256').update(operationId).digest('hex');
      let marker;
      try {
        marker = await open(join(operations, `${operationKey}.json`), 'wx', 0o600);
      } catch {
        throw new Error('This task cannot start another rotation. Inspect its evidence and local state before recovery.');
      }
      // Retain this marker on all failures, including a process interruption.
      // A retry must never repeat a mutation merely because evidence delivery failed.
      try {
        await marker.writeFile(JSON.stringify({ operationId, status: 'attempted' }));
        await marker.sync();
      } finally { await marker.close(); }

      const version = `version-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + lifetimeDays * 86_400_000).toISOString();
      const temporaryPath = join(stateDirectory, `.secret-${randomUUID()}.tmp`);
      try {
        const file = await open(temporaryPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({
            schemaVersion: 1, version, createdAt, expiresAt, operationId,
            value: randomBytes(32).toString('base64url'),
          }));
          await file.sync();
        } finally { await file.close(); }
        await rename(temporaryPath, join(stateDirectory, 'demo-secret.json'));
      } catch {
        throw new Error('Local rotation did not complete cleanly. Inspect local state before recovery.');
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      return { version, expiresAt };
    },
  };
}
