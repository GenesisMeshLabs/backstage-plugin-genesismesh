import type { AuthService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { ActionReport, ResourceAction } from 'genesis-mesh-sdk';
import type { GovernedExecutor, TrustBinding } from './governedExecutor.js';

export type ActionParameters = Record<string, string | number | boolean>;
/** Register a provider adapter as an authenticated, checkpointed Backstage action. */
export function createGovernedScaffolderAction(options: {
  id: string;
  description: string;
  auth: Pick<AuthService, 'isPrincipal'>;
  executor: GovernedExecutor;
  allowServiceInitiators?: boolean;
  resourceId: (taskId: string) => string;
  resourceAction: ResourceAction;
  validate: (parameters: ActionParameters) => ActionParameters;
  execute: (parameters: ActionParameters, taskId: string, binding: TrustBinding) => Promise<ActionReport<Record<string, string | number | boolean>>>;
}) {
  return createTemplateAction({
    id: options.id, description: options.description, supportsDryRun: false,
    schema: {
      input: z => z.object({ parameters: z.record(z.union([z.string().max(128), z.number().finite(), z.boolean()])) }).strict(),
      output: { decisionId: z => z.string(), evidenceStatus: z => z.string(), result: z => z.string() },
    },
    async handler(ctx) {
      const credentials = await ctx.getInitiatorCredentials();
      let initiatorType: 'user' | 'service';
      let initiatorRef: string;
      if (options.auth.isPrincipal(credentials, 'user')) {
        initiatorType = 'user'; initiatorRef = credentials.principal.userEntityRef;
      } else if (options.allowServiceInitiators && options.auth.isPrincipal(credentials, 'service')) {
        initiatorType = 'service'; initiatorRef = credentials.principal.subject;
      } else throw new Error('An authenticated, permitted Backstage initiator is required.');
      const parameters = options.validate(ctx.input.parameters);
      const result = await ctx.checkpoint({ key: `${options.id}:v1`, fn: async () => {
        const execution = await options.executor.run({
          parameters, resourceId: options.resourceId(ctx.task.id), resourceAction: options.resourceAction,
          provenance: { taskId: ctx.task.id, initiatorRef, initiatorType }, signal: ctx.signal,
        }, ({ binding }) => options.execute(parameters, ctx.task.id, binding));
        return { decisionId: execution.decisionId, evidenceStatus: execution.evidenceStatus,
          result: JSON.stringify(execution.value ?? {}) };
      } });
      ctx.output('decisionId', result.decisionId);
      ctx.output('evidenceStatus', result.evidenceStatus);
      ctx.output('result', result.result);
      ctx.logger.info(`Genesis Mesh execution finished; evidence status: ${result.evidenceStatus}.`);
    },
  });
}
