import { readFile } from 'node:fs/promises';
import {
  verifyAttestationSignature,
  verifyPolicySignature,
  type BoundaryPolicy,
  type MembershipAttestation,
} from 'genesis-mesh-sdk';

export interface GenesisMeshConnection {
  schemaVersion: 1;
  baseUrl: string;
  networkName: string;
  naPublicKey: string;
  naKeyId: string;
  controller: { keyId: string; seedBase64: string };
  executor: { keyId: string; seedBase64: string; sovereignId: string };
  policy: BoundaryPolicy;
  attestation: MembershipAttestation;
  appId: string;
  resourceId: string;
  capability: 'secret.rotate';
  maxLifetimeDays: number;
}

const invalid = () => new Error('Invalid Genesis Mesh local connection fixture. Run local:setup again.');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_.\/-]{1,256}$/.test(value)) throw invalid();
  return value;
}

function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalid();
  if (Buffer.from(value, 'base64').length !== 32) throw invalid();
  return value;
}

/** Only local lab authorities are supported by this proof-of-integration. */
export function parseConnection(value: unknown): GenesisMeshConnection {
  const raw = object(value);
  if (raw.schemaVersion !== 1 || typeof raw.baseUrl !== 'string') throw invalid();
  let endpoint: URL;
  try { endpoint = new URL(raw.baseUrl); } catch { throw invalid(); }
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    || !['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') throw invalid();
  const controller = object(raw.controller);
  const executor = object(raw.executor);
  const naPublicKey = key(raw.naPublicKey);
  const policy = object(raw.policy) as unknown as BoundaryPolicy;
  const attestation = object(raw.attestation) as unknown as MembershipAttestation;
  try {
    if (!verifyPolicySignature(policy, [naPublicKey])
      || !verifyAttestationSignature(attestation, [naPublicKey])) throw invalid();
  } catch { throw invalid(); }
  if (raw.capability !== 'secret.rotate' || raw.appId !== 'backstage-demo'
    || raw.resourceId !== 'local:backstage-demo/api-key'
    || !Number.isSafeInteger(raw.maxLifetimeDays)
    || (raw.maxLifetimeDays as number) < 1 || (raw.maxLifetimeDays as number) > 365) throw invalid();
  // Deliberately construct an allowlisted object. The privileged setup key is
  // never exposed to the plugin, even when the fixture contains it for tests.
  return {
    schemaVersion: 1,
    baseUrl: endpoint.origin,
    networkName: identifier(raw.networkName),
    naPublicKey,
    naKeyId: identifier(raw.naKeyId),
    controller: { keyId: identifier(controller.keyId), seedBase64: key(controller.seedBase64) },
    executor: {
      keyId: identifier(executor.keyId),
      seedBase64: key(executor.seedBase64),
      sovereignId: identifier(executor.sovereignId),
    },
    policy,
    attestation,
    appId: raw.appId,
    resourceId: raw.resourceId,
    capability: raw.capability,
    maxLifetimeDays: raw.maxLifetimeDays as number,
  };
}

export async function loadConnectionFile(path: string): Promise<GenesisMeshConnection> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); } catch { throw invalid(); }
  return parseConnection(raw);
}
