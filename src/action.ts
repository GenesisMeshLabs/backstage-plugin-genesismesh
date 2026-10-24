import type { AuthService, BackstageCredentials } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { GenesisMeshService, RotationRequest } from './service.js';

export const ROTATE_ACTION_ID = 'genesismesh:demoSecret:rotate';

export function createRotateDemoSecretAction(options: {
  service: GenesisMeshService;
  auth: Pick<AuthService, 'isPrincipal'>;
  allowServiceInitiators?: boolean;
}) {
  return createTemplateAction({
    id: ROTATE_ACTION_ID,
    description: 'Rotate a simulated local secret only after a verified Genesis Mesh policy decision.',
    supportsDryRun: false,
    schema: {
      input: z => z.object({
        lifetimeDays: z.number().int().min(1).max(365)
          .describe('Requested lifetime metadata in days; the authority decides whether it is allowed.'),
      }).strict(),
      output: {
        decisionId: z => z.string(),
        resourceId: z => z.string(),
        version: z => z.string(),
        evidenceStatus: z => z.enum(['recorded', 'duplicate', 'pending', 'dead_letter']),
      },
    },
    async handler(ctx) {
      let credentials: BackstageCredentials;
      try { credentials = await ctx.getInitiatorCredentials(); } catch {
        throw new Error('The task initiator credentials could not be verified. The secret was not changed.');
      }
      let provenance: RotationRequest['provenance'];
      if (options.auth.isPrincipal(credentials, 'user')) {
        provenance = { taskId: ctx.task.id, initiatorType: 'user', initiatorRef: credentials.principal.userEntityRef };
      } else if (options.allowServiceInitiators && options.auth.isPrincipal(credentials, 'service')) {
        provenance = { taskId: ctx.task.id, initiatorType: 'service', initiatorRef: credentials.principal.subject };
      } else {
        throw new Error('An authenticated user is required; service initiators need explicit local demo configuration.');
      }
      ctx.logger.info('Requesting a Genesis Mesh decision for the configured demo resource.');
      const result = await ctx.checkpoint({
        key: 'genesismesh-demo-secret-rotation-v1',
        fn: async () => ({ ...await options.service.rotate({
          lifetimeDays: ctx.input.lifetimeDays,
          provenance,
          signal: ctx.signal,
        }) }),
      });
      ctx.output('decisionId', result.decisionId);
      ctx.output('resourceId', result.resourceId);
      ctx.output('version', result.version);
      ctx.output('evidenceStatus', result.evidenceStatus);
      if (result.evidenceStatus === 'pending' || result.evidenceStatus === 'dead_letter') {
        ctx.logger.warn('The rotation completed, but evidence requires delivery or operator review. Do not rerun the rotation.');
      } else {
        ctx.logger.info('The demo rotation completed and its execution evidence was admitted.');
      }
    },
  });
}
