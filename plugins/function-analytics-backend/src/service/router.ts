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

import express from 'express';
import Router from 'express-promise-router';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import { preprocessTraces } from '../lib/preprocess';
import { analyzeFunctionCalls } from '../lib/analysis';
import { applyDecisionLogic } from '../lib/decision';

/**
 * Dependencies of the function-analytics router
 */
export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
}

/**
 * Creates an express.Router with endpoints for function analytics
 *
 * @param options - the dependencies of the router
 * @returns an express.Router
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, response) => {
    logger.info('Function Analytics health check');
    response.json({ status: 'ok' });
  });

  router.get('/analyze', async (req, res) => {
    try {
      const service = (req.query.service as string) || 'all';
      logger.info(`Analyzing function calls for service: ${service}`);

      // Construct Jaeger API URL through Backstage proxy
      const jaegerUrl = `http://localhost:7007/api/proxy/jaeger/api/traces?service=${service}&limit=500`;

      logger.info(`Fetching traces from Jaeger: ${jaegerUrl}`);

      // Fetch traces from Jaeger
      const response = await fetch(jaegerUrl);
      
      if (!response.ok) {
        throw new Error(`Jaeger API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Ensure data structure is correct
      const traces = Array.isArray(data) ? data : (data.data || []);

      logger.info(`Fetched ${traces.length} traces from Jaeger`);

      // Step 1: Preprocess traces
      const cleaned = preprocessTraces(traces);
      logger.info(`Preprocessed ${cleaned.length} function calls`);

      // Step 2: Analyze function calls
      const analyzed = analyzeFunctionCalls(cleaned);
      logger.info(`Analyzed ${analyzed.length} unique functions`);

      // Step 3: Apply decision logic
      const decisions = applyDecisionLogic(analyzed);
      logger.info(`Generated ${decisions.length} relocation recommendations`);

      res.json(decisions);
    } catch (error) {
      logger.error(`Error analyzing function calls: ${error}`);
      res.status(500).json({ 
        error: 'Failed to analyze function calls',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
