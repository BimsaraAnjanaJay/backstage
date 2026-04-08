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

import * as fs from 'fs-extra';
import * as path from 'path';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * For every immediate subdirectory of repoPath that contains a Node.js app,
 * writes an `otel-server.js` file that:
 *  - Loads @opentelemetry/auto-instrumentations-node/register (reliable require, no NODE_OPTIONS)
 *  - If the service has its own app.listen(), just requires index.js
 *  - If the service only exports a router (no app.listen()), wraps it in Express
 *
 * The startup command in the generated compose always uses `node otel-server.js`
 * so this is the single reliable entry point for OTEL + the service.
 */
export async function createServerWrappers(
  repoPath: string,
  logger: LoggerService,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(repoPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const servicePath = path.join(repoPath, entry.name);
    const indexPath = path.join(servicePath, 'index.js');

    if (!(await fs.pathExists(indexPath))) continue;

    const content = await fs.readFile(indexPath, 'utf-8');
    const hasServer = content.includes('.listen(');
    const isRouterModule = !hasServer && content.includes('module.exports');

    if (!hasServer && !isRouterModule) continue;

    const wrapperPath = path.join(servicePath, 'otel-server.js');

    // Shared OTEL function-tracing patch — wraps named route handlers so that
    // business function names (e.g. getAllUsers, save, checkUserExists) appear
    // as spans in Jaeger instead of only the generic HTTP route spans.
    const otelPatch = `
// ── FRA: wrap named Express route handlers with OTEL spans ───────────────────
const otel = require('@opentelemetry/api');

function wrapHandlerWithSpan(handler) {
  if (typeof handler !== 'function') return handler;
  const fnName = handler.name;
  // Only wrap named, non-anonymous, non-framework functions
  if (!fnName || fnName === 'anonymous' || fnName === 'bound dispatch' ||
      fnName.startsWith('bound ') || fnName === 'handle' || fnName === 'next') {
    return handler;
  }
  const wrapped = function wrappedHandler(req, res, next) {
    const tracer = otel.trace.getTracer('fra-auto');
    return tracer.startActiveSpan(fnName, span => {
      span.setAttribute('fra.handler', fnName);
      span.setAttribute('http.method', req.method || '');
      span.setAttribute('http.route', req.route ? req.route.path : req.path || '');
      try {
        const result = handler.call(this, req, res, function(err) {
          span.end();
          next(err);
        });
        // If the handler doesn't call next (terminal handler), end span when response finishes
        if (result && typeof result.then === 'function') {
          result.then(() => span.end()).catch(e => { span.recordException(e); span.end(); });
        } else if (!res.headersSent) {
          res.on('finish', () => span.end());
        }
        return result;
      } catch (e) {
        span.recordException(e);
        span.end();
        throw e;
      }
    });
  };
  Object.defineProperty(wrapped, 'name', { value: fnName });
  return wrapped;
}

function patchRouter(router) {
  if (!router || router.__fraPatched) return router;
  router.__fraPatched = true;
  ['get','post','put','patch','delete','use','all'].forEach(method => {
    const orig = router[method];
    if (typeof orig !== 'function') return;
    router[method] = function(...args) {
      const patched = args.map(a => Array.isArray(a)
        ? a.map(wrapHandlerWithSpan)
        : wrapHandlerWithSpan(a));
      return orig.apply(this, patched);
    };
  });
  return router;
}

// Patch express.Router so all routers created after this point are wrapped
const express = require('express');
const origRouter = express.Router.bind(express);
express.Router = function(...args) {
  return patchRouter(origRouter(...args));
};
const origApp = express;
const origApplication = express.application;
if (origApplication) {
  ['get','post','put','patch','delete','use','all'].forEach(method => {
    const orig = origApplication[method];
    if (typeof orig !== 'function') return;
    origApplication[method] = function(...args) {
      const patched = args.map(a => Array.isArray(a)
        ? a.map(wrapHandlerWithSpan)
        : wrapHandlerWithSpan(a));
      return orig.apply(this, patched);
    };
  });
}
// ─────────────────────────────────────────────────────────────────────────────
`;

    if (hasServer) {
      // Service already has an HTTP server — load OTEL, apply patch, then require the app
      await fs.writeFile(
        wrapperPath,
        `// Auto-generated by FRA: loads OTEL + function-name tracing patch, then starts the existing HTTP server
require('@opentelemetry/auto-instrumentations-node/register');
${otelPatch}
require('./index.js');
`,
      );
      logger.info(
        `📡 Created OTEL wrapper for ${entry.name} (delegates to index.js server)`,
      );
    } else {
      // Router-only service — wrap in a minimal Express server
      await fs.writeFile(
        wrapperPath,
        `// Auto-generated by FRA: wraps exported router in a standalone Express server with OTEL
require('@opentelemetry/auto-instrumentations-node/register');
${otelPatch}
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

try {
  const router = require('./index.js');
  if (router && typeof router === 'function') {
    app.use('/', router);
  }
} catch (e) {
  console.error('[otel-server] Failed to load router:', e.message);
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: '${entry.name}' }));

app.listen(PORT, () => {
  console.log('[otel-server] ${entry.name} running on port ' + PORT);
});
`,
      );
      logger.info(
        `📦 Created OTEL + HTTP server wrapper for ${entry.name} (index.js exports router without listen)`,
      );
    }
  }
}
