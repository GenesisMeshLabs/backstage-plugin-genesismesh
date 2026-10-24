import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ExecutionRecorder, FileOutbox, GenesisMeshClient, governedAction, seedSigner,
  verifyAttestationSignature, verifyPolicySignature,
  type ActionReport, type BoundaryPolicy, type MembershipAttestation,
  type ResourceAction, type DecisionSummary,
} from 'genesis-mesh-sdk';
import type { RotationRequest } from './service.js';

export interface AuthorityConnection {
  baseUrl: string;
  naPublicKey: string;
  controller: { keyId: string; seedBase64: string };
  executor: { keyId: string; seedBase64: string; sovereignId: string };
}
export interface TrustBinding {
  capability: string;
  policy: BoundaryPolicy;
  attestation: MembershipAttestation;
}
export interface GovernedRequest {
  resourceId: string;
  resourceAction?: ResourceAction;
  parameters: Record<string, string | number | boolean>;
  provenance: RotationRequest['provenance'];
  signal?: AbortSignal;
}
export interface GovernedResult<T> {
  value: T | undefined;
  decisionId: string;
  summary: DecisionSummary;
  evidenceStatus: 'recorded' | 'duplicate' | 'pending' | 'dead_letter';
  attestationId: string;
}
export class GovernedRequestDeniedError extends Error {
  constructor(readonly decisionId: string, readonly summary: DecisionSummary) {
    super(`Genesis Mesh denied the request: ${summary.enforced_failures.map(gate => gate.gate).join(', ') || 'delegation unavailable'}. No operation was executed.`);
    this.name = 'GovernedRequestDeniedError';
  }
}

/** Provider-independent execution. A backend binds policy, resource and adapter; templates never supply keys. */
export async function createGovernedExecutor(options: {
  connection: AuthorityConnection;
  binding: () => TrustBinding;
  stateDirectory: string;
}) {
  const endpoint = new URL(options.connection.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Invalid authority endpoint.');
  }
  if (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Remote authorities require HTTPS.');
  }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const outbox = new FileOutbox(join(options.stateDirectory, 'evidence-outbox'));
  const client = new GenesisMeshClient({
    baseUrl: endpoint.origin, audience: options.connection.naPublicKey,
    signingKeyBase64: options.connection.controller.seedBase64, keyId: options.connection.controller.keyId,
    timeout: 5_000, retry: { attempts: 0 }, outbox,
  });
  const recorder = new ExecutionRecorder({
    executorSovereignId: options.connection.executor.sovereignId,
    signer: seedSigner(options.connection.executor.seedBase64, options.connection.executor.keyId),
  });
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    flushEvidence: () => serial(() => client.evidenceStore.flushPending()),
    run<T>(request: GovernedRequest, action: (context: { binding: TrustBinding }) => Promise<ActionReport<T>>): Promise<GovernedResult<T>> {
      return serial(async () => {
        let attempted = false;
        try {
          request.signal?.throwIfAborted();
          const binding = structuredClone(options.binding());
          if (!binding.capability || !verifyPolicySignature(binding.policy, [options.connection.naPublicKey])
            || !verifyAttestationSignature(binding.attestation, [options.connection.naPublicKey])) {
            throw new Error('Unverifiable trust binding.');
          }
          for (const value of [request.resourceId, request.provenance.taskId, request.provenance.initiatorRef]) {
            if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\u0000]/.test(value)) {
              throw new Error('Invalid request identity.');
            }
          }
          if (!['user', 'service'].includes(request.provenance.initiatorType)) throw new Error('Invalid principal.');
          const result = await governedAction(client, recorder, {
            attestation_id: binding.attestation.attestation_id,
            requested_capability: binding.capability,
            context: { request_parameters: request.parameters, attributes: {
              backstage_task_id: request.provenance.taskId,
              backstage_initiator_type: request.provenance.initiatorType,
              backstage_initiator_ref: request.provenance.initiatorRef,
              resource_id: request.resourceId,
            } },
            // The protocol pairs resource_id with a mutation action. Reads retain
            // their resource in decision context and record execution without a
            // fabricated resource mutation.
            resource_id: request.resourceAction ? request.resourceId : undefined,
            resource_action: request.resourceAction,
            verify: { operatorPublicKeys: [options.connection.naPublicKey], expectedPolicies: [binding.policy], expectedAttestation: binding.attestation },
          }, async () => {
            request.signal?.throwIfAborted();
            attempted = true;
            return action({ binding });
          });
          if (!result.authorized) throw new GovernedRequestDeniedError(result.evaluation.decision.decision_id, result.summary);
          return { value: result.value, decisionId: result.evaluation.decision.decision_id,
            summary: result.summary, attestationId: binding.attestation.attestation_id,
            evidenceStatus: result.submission?.status ?? result.queued?.state ?? 'pending' };
        } catch (error) {
          if (error instanceof GovernedRequestDeniedError) throw error;
          throw new Error(attempted
            ? 'The operation was attempted. Inspect resource state and evidence before recovery; do not retry automatically.'
            : 'Genesis Mesh authorization or verification is unavailable. No operation was executed.');
        }
      });
    },
  };
}
export type GovernedExecutor = Awaited<ReturnType<typeof createGovernedExecutor>>;
