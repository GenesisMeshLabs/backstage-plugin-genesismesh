import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  EvidenceNotKeptError,
  ExecutionRecorder,
  FileOutbox,
  GenesisMeshClient,
  MetadataRefusedError,
  governedAction,
  seedSigner,
} from 'genesis-mesh-sdk';
import { type GenesisMeshConnection, parseConnection } from './connection.js';
import { createLocalSecretAdapter, type SecretRotationAdapter } from './localSecretAdapter.js';

export interface RotationRequest {
  lifetimeDays: number;
  provenance: { taskId: string; initiatorType: 'user' | 'service'; initiatorRef: string };
  signal?: AbortSignal;
}

export interface RotationResult {
  decisionId: string;
  resourceId: string;
  version: string;
  evidenceStatus: 'recorded' | 'duplicate' | 'pending' | 'dead_letter';
}

export interface GenesisMeshService {
  rotate(request: RotationRequest): Promise<RotationResult>;
}

export class GovernanceDeniedError extends Error {
  constructor(readonly decisionId: string) {
    super('Genesis Mesh denied this request. The secret was not changed.');
    this.name = 'GovernanceDeniedError';
  }
}

/** No provider operation retries and no break-glass execution. */
export async function createGenesisMeshService(options: {
  connection: GenesisMeshConnection;
  stateDirectory: string;
  adapter?: SecretRotationAdapter;
}): Promise<GenesisMeshService> {
  const connection = parseConnection(options.connection);
  const stateDirectory = resolve(options.stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const outbox = new FileOutbox(join(stateDirectory, 'evidence-outbox'));
  const client = new GenesisMeshClient({
    baseUrl: connection.baseUrl,
    audience: connection.naPublicKey,
    signingKeyBase64: connection.controller.seedBase64,
    keyId: connection.controller.keyId,
    timeout: 5_000,
    retry: { attempts: 0 },
    outbox,
  });
  const recorder = new ExecutionRecorder({
    executorSovereignId: connection.executor.sovereignId,
    signer: seedSigner(connection.executor.seedBase64, connection.executor.keyId),
  });
  const adapter = options.adapter ?? createLocalSecretAdapter(stateDirectory);
  let queue = Promise.resolve();

  async function execute(request: RotationRequest): Promise<RotationResult> {
    if (!Number.isSafeInteger(request.lifetimeDays) || request.lifetimeDays < 1 || request.lifetimeDays > 365) {
      throw new Error('lifetimeDays must be an integer between 1 and 365.');
    }
    const safeReference = (value: unknown): value is string => typeof value === 'string'
      && value.length > 0 && value.length <= 512 && !/[\r\n\u0000]/.test(value);
    if (!safeReference(request.provenance.taskId) || !safeReference(request.provenance.initiatorRef)
      || !['user', 'service'].includes(request.provenance.initiatorType)) {
      throw new Error('A Backstage task and authenticated initiator are required.');
    }
    let mutationStarted = false;
    try {
      request.signal?.throwIfAborted();
      const result = await governedAction(client, recorder, {
        attestation_id: connection.attestation.attestation_id,
        requested_capability: connection.capability,
        context: {
          request_parameters: { app_id: connection.appId, lifetime_days: request.lifetimeDays },
          attributes: {
            backstage_task_id: request.provenance.taskId,
            backstage_initiator_type: request.provenance.initiatorType,
            backstage_initiator_ref: request.provenance.initiatorRef,
            environment: 'local-demo',
          },
        },
        resource_id: connection.resourceId,
        resource_action: 'rotate',
        verify: {
          operatorPublicKeys: [connection.naPublicKey],
          expectedPolicies: [connection.policy],
          expectedAttestation: connection.attestation,
        },
      }, async () => {
        request.signal?.throwIfAborted();
        mutationStarted = true;
        const metadata = await adapter.rotate({
          lifetimeDays: request.lifetimeDays,
          operationId: request.provenance.taskId,
        });
        return {
          value: metadata,
          execution_parameters: { secret_version: metadata.version, expires_on: metadata.expiresAt },
        };
      });
      if (!result.authorized) throw new GovernanceDeniedError(result.evaluation.decision.decision_id);
      if (!result.value) throw new Error('Missing local provider result.');
      return {
        decisionId: result.evaluation.decision.decision_id,
        resourceId: connection.resourceId,
        version: result.value.version,
        evidenceStatus: result.submission?.status ?? result.queued?.state ?? 'pending',
      };
    } catch (error) {
      if (error instanceof GovernanceDeniedError) throw error;
      if (mutationStarted || error instanceof EvidenceNotKeptError || error instanceof MetadataRefusedError) {
        throw new Error('The rotation was attempted. Inspect local state and evidence before recovery; do not rerun the task.');
      }
      // SDK and network errors can contain request details. Keep task-visible
      // errors fixed and free of credentials or provider response bodies.
      throw new Error('Genesis Mesh authorization or verification was unavailable. The secret was not changed.');
    }
  }

  return {
    rotate(request) {
      // The SDK evidence chain and file adapter require serialized mutations.
      const result = queue.then(() => execute(request));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
