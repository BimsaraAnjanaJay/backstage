import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
// We no longer import createTodoListService

/**
 * codeAnalysisBackendPlugin backend plugin
 *
 * @public
 */
export const codeAnalysisBackendPlugin = createBackendPlugin({
  pluginId: 'code-analysis-backend',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        // httpAuth: coreServices.httpAuth, // Removed: Our router doesn't use this
        httpRouter: coreServices.httpRouter,
        catalog: catalogServiceRef,
        
        // Added: These are required by our router
        reader: coreServices.urlReader,
        config: coreServices.rootConfig,

        discovery: coreServices.discovery,
        auth: coreServices.auth,      
        httpAuth: coreServices.httpAuth,
      },

      // Updated init function signature to receive the new dependencies
      async init({ logger, httpRouter, catalog, reader, config, discovery, auth, httpAuth }) {
        logger.info('Initializing code-analysis-backend plugin...'); // Added a log line

        // Removed: todoListService creation
        // const todoListService = await createTodoListService({
        //   logger,
        //   catalog,
        // });

        httpRouter.use(
          await createRouter({
            // Passed the correct dependencies to the router
            logger,
            reader,
            catalog,
            config,
            discovery,
            auth,
            httpAuth,
          }),
        );
      },
    });
  },
});

// Added default export, which is best practice
export default codeAnalysisBackendPlugin;