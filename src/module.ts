import { resolve } from 'node:path';
import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createRotateDemoSecretAction } from './action.js';
import { loadConnectionFile } from './connection.js';
import { createGenesisMeshService } from './service.js';

export const genesismeshScaffolderModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'genesismesh',
  register(env) {
    env.registerInit({
      deps: { actions: scaffolderActionsExtensionPoint, config: coreServices.rootConfig, auth: coreServices.auth },
      async init({ actions, config, auth }) {
        if (config.getOptionalBoolean('genesismesh.localDemo.enabled') !== true) {
          throw new Error('The Genesis Mesh local adapter requires genesismesh.localDemo.enabled: true.');
        }
        const connection = await loadConnectionFile(resolve(config.getString('genesismesh.connectionFile')));
        const service = await createGenesisMeshService({
          connection,
          stateDirectory: resolve(config.getString('genesismesh.stateDirectory')),
        });
        actions.addActions(createRotateDemoSecretAction({
          service,
          auth,
          allowServiceInitiators: config.getOptionalBoolean('genesismesh.localDemo.allowServiceInitiators') === true,
        }));
      },
    });
  },
});
