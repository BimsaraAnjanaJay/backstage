/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { FraConfig, FraConfigSchema } from './modules/config/FraConfig';

/**
 * The function analytics backend plugin.
 *
 * @public
 */
export const functionAnalyticsPlugin = createBackendPlugin({
  pluginId: 'function-analytics',
  register(env) {
    env.registerInit({
      deps: {
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        rootConfig: coreServices.rootConfig,
      },
      async init({ httpAuth, logger, httpRouter, rootConfig }) {
        // Build FraConfig from app-config.yaml `fra:` block if present,
        // falling back to hardcoded defaults for every omitted key.
        const fraConfigOverrides: Partial<FraConfigSchema> = {};
        try {
          const fraBlock = rootConfig.getOptionalConfig('fra');
          if (fraBlock) {
            const workspaceRoot = fraBlock.getOptionalString('workspaceRoot');
            if (workspaceRoot) fraConfigOverrides.workspaceRoot = workspaceRoot;

            const tracingBlock = fraBlock.getOptionalConfig('tracing');
            if (tracingBlock) {
              const defaultLookbackHours = tracingBlock.getOptionalNumber(
                'defaultLookbackHours',
              );
              const maxTracesPerService = tracingBlock.getOptionalNumber(
                'maxTracesPerService',
              );
              fraConfigOverrides.tracing = {
                ...FraConfig.defaults().tracing,
                ...(defaultLookbackHours !== undefined && {
                  defaultLookbackHours,
                }),
                ...(maxTracesPerService !== undefined && {
                  maxTracesPerService,
                }),
              };
            }

            const discoveryBlock = fraBlock.getOptionalConfig('discovery');
            if (discoveryBlock) {
              const minConfidenceThreshold = discoveryBlock.getOptionalNumber(
                'minConfidenceThreshold',
              );
              const maxScanDepth =
                discoveryBlock.getOptionalNumber('maxScanDepth');
              fraConfigOverrides.discovery = {
                ...FraConfig.defaults().discovery,
                ...(minConfidenceThreshold !== undefined && {
                  minConfidenceThreshold,
                }),
                ...(maxScanDepth !== undefined && { maxScanDepth }),
              };
            }

            const catalogBlock = fraBlock.getOptionalConfig('catalog');
            if (catalogBlock) {
              const defaultOwner =
                catalogBlock.getOptionalString('defaultOwner');
              const defaultLifecycle =
                catalogBlock.getOptionalString('defaultLifecycle');
              const dryRun = catalogBlock.getOptionalBoolean('dryRun');
              fraConfigOverrides.catalog = {
                ...FraConfig.defaults().catalog,
                ...(defaultOwner !== undefined && { defaultOwner }),
                ...(defaultLifecycle !== undefined && { defaultLifecycle }),
                ...(dryRun !== undefined && { dryRun }),
              };
            }

            const analysisBlock = fraBlock.getOptionalConfig('analysis');
            if (analysisBlock) {
              const externalCallThreshold = analysisBlock.getOptionalNumber(
                'externalCallThreshold',
              );
              const confidenceMargin =
                analysisBlock.getOptionalNumber('confidenceMargin');
              const minSampleSizeForHighConfidence =
                analysisBlock.getOptionalNumber(
                  'minSampleSizeForHighConfidence',
                );
              fraConfigOverrides.analysis = {
                ...FraConfig.defaults().analysis,
                ...(externalCallThreshold !== undefined && {
                  externalCallThreshold,
                }),
                ...(confidenceMargin !== undefined && { confidenceMargin }),
                ...(minSampleSizeForHighConfidence !== undefined && {
                  minSampleSizeForHighConfidence,
                }),
              };
            }
          }
        } catch (e) {
          logger.warn(`Could not read fra: config block, using defaults: ${e}`);
        }

        const fraConfig = new FraConfig(fraConfigOverrides);

        httpRouter.use(
          await createRouter({
            httpAuth,
            logger,
            config: fraConfig,
          }),
        );
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/fra/config',
          allow: 'unauthenticated',
        });
      },
    });
  },
});
