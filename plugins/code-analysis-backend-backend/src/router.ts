import express from 'express';
import { Logger } from 'winston';
import { UrlReaderService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { fetchCodeFromRepo } from './fetchCodeFromRepo';
import fetch from 'node-fetch';

export interface RouterOptions {
  logger: Logger;
  reader: UrlReaderService;
  discovery: any;
  auth: any;
  httpAuth: any;
}

const CLONE_API_URL = process.env.CLONE_API_URL ?? 'http://localhost:5001';

export async function createRouter(options: RouterOptions): Promise<express.Router> {
  const { logger, reader, discovery, auth, httpAuth } = options;

  const router = express.Router();
  const catalog = new CatalogClient({ discoveryApi: discovery });

  router.use(express.json());

  // ── Auth helper ────────────────────────────────────────────────────────────
  async function getCatalogToken(req: express.Request): Promise<string | undefined> {
    try {
      const creds = await httpAuth.credentials(req);
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: creds,
        targetPluginId: 'catalog',
      });
      return token;
    } catch {
      return undefined;
    }
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ── GET /list-projects ─────────────────────────────────────────────────────
  // Returns all Systems, each with their member services (Components).
  // Services with no system go into "ungrouped".
  //
  // Response shape:
  // {
  //   "projects": [
  //     { "name": "ecommerce-microservices", "description": "...",
  //       "services": ["order-service", "inventory-service", ...] },
  //     { "name": "ungrouped", "description": "...", "services": [...] }
  //   ]
  // }
  router.get('/list-projects', async (req, res) => {
    try {
      const token = await getCatalogToken(req);

      // Fetch all System entities
      const { items: systems } = await catalog.getEntities(
        { filter: { kind: 'System' } },
        { token },
      );

      // Fetch all Component entities that have a source-location annotation
      const { items: components } = await catalog.getEntities(
        { filter: { kind: 'Component' } },
        { token },
      );
      const withSource = components.filter(
        e => e.metadata.annotations?.['backstage.io/source-location'],
      );

      // Build project map from System entities first
      const projectMap = new Map<string, { description: string; services: string[] }>();
      for (const sys of systems) {
        projectMap.set(sys.metadata.name, {
          description: sys.metadata.description ?? '',
          services: [],
        });
      }

      // Assign each component to its system (spec.system field)
      for (const comp of withSource) {
        const systemName = (comp.spec as any)?.system ?? 'ungrouped';
        if (!projectMap.has(systemName)) {
          projectMap.set(systemName, {
            description: systemName === 'ungrouped'
              ? 'Services not assigned to any system'
              : '',
            services: [],
          });
        }
        projectMap.get(systemName)!.services.push(comp.metadata.name);
      }

      // Sort services alphabetically within each project
      for (const proj of projectMap.values()) {
        proj.services.sort();
      }

      // Convert to array, filter empty systems, ungrouped goes last
      const projects = Array.from(projectMap.entries())
        .map(([name, data]) => ({ name, ...data }))
        .filter(p => p.services.length > 0)
        .sort((a, b) => {
          if (a.name === 'ungrouped') return 1;
          if (b.name === 'ungrouped') return -1;
          return a.name.localeCompare(b.name);
        });

      return res.json({ projects });
    } catch (e: any) {
      logger.error(`list-projects error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /list-services (kept for backwards compatibility) ──────────────────
  router.get('/list-services', async (req, res) => {
    try {
      const token = await getCatalogToken(req);
      const { items: entities } = await catalog.getEntities(
        { filter: { kind: 'Component' } },
        { token },
      );
      const services = entities
        .filter(e => e.metadata.annotations?.['backstage.io/source-location'])
        .map(e => e.metadata.name)
        .sort();
      return res.json({ services });
    } catch (e: any) {
      logger.error(`list-services error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /analyze (existing — unchanged) ──────────────────────────────────
  router.post('/analyze', async (req, res) => {
    const { entityRef } = req.body;
    if (!entityRef) {
      return res.status(400).json({ error: 'Missing entityRef in body' });
    }
    try {
      const token = await getCatalogToken(req);
      const entity = await catalog.getEntityByRef(entityRef, { token });
      if (!entity) {
        return res.status(404).json({ error: `Entity '${entityRef}' not found` });
      }
      let repoUrl = entity.metadata.annotations?.['backstage.io/source-location'];
      if (!repoUrl) {
        return res.status(400).json({
          error: `Entity ${entityRef} has no backstage.io/source-location annotation`,
        });
      }
      if (repoUrl.startsWith('url:')) repoUrl = repoUrl.replace('url:', '');
      const files = await fetchCodeFromRepo(repoUrl, reader, logger);
      return res.json({ entityRef, repoUrl, fileCount: files.length, files });
    } catch (e: any) {
      logger.error(`Error analyzing entity: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /analyze-all ──────────────────────────────────────────────────────
  // Body: { threshold?: number, selected_services: string[] }
  router.post('/analyze-all', async (req, res) => {
    const threshold                  = parseFloat(req.body?.threshold ?? '0.85');
    const selectedServices: string[] = req.body?.selected_services ?? [];

    try {
      const token = await getCatalogToken(req);

      const { items: entities } = await catalog.getEntities(
        { filter: { kind: 'Component' } },
        { token },
      );

      let withSource = entities.filter(
        e => e.metadata.annotations?.['backstage.io/source-location'],
      );

      if (selectedServices.length > 0) {
        const selSet = new Set(selectedServices);
        withSource = withSource.filter(e => selSet.has(e.metadata.name));
      }

      if (withSource.length < 2) {
        return res.status(400).json({
          error: 'Select at least 2 services to run cross-service clone detection.',
          found: withSource.length,
        });
      }

      const servicesPayload = await Promise.all(
        withSource.map(async entity => {
          const serviceName = entity.metadata.name;
          let repoUrl = entity.metadata.annotations!['backstage.io/source-location'];
          if (repoUrl.startsWith('url:')) repoUrl = repoUrl.replace('url:', '');
          logger.info(`  Fetching: ${serviceName} <- ${repoUrl}`);
          const files = await fetchCodeFromRepo(repoUrl, reader, logger);
          logger.info(`  ${serviceName}: ${files.length} file(s)`);
          return { service: serviceName, files };
        }),
      );

      const totalFiles = servicesPayload.reduce((n, s) => n + s.files.length, 0);

      try {
        const healthCheck = await fetch(`${CLONE_API_URL}/health`, { method: 'GET' });
        if (!healthCheck.ok) throw new Error('unhealthy');
      } catch {
        return res.status(503).json({
          error: 'Python clone detection API is not running. Start it with: py clone_api.py',
        });
      }

      const cloneResp = await fetch(`${CLONE_API_URL}/detect-clones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold, services: servicesPayload }),
      });

      if (!cloneResp.ok) {
        const errText = await cloneResp.text();
        return res.status(502).json({ error: `Clone API error: ${errText}` });
      }

      const cloneReport = await cloneResp.json();

      return res.json({
        catalog_summary: {
          total_components:       entities.length,
          components_with_source: withSource.length,
          services_analysed:      servicesPayload.length,
          service_names:          servicesPayload.map(s => s.service),
          total_files_fetched:    totalFiles,
        },
        ...cloneReport,
      });

    } catch (e: any) {
      logger.error(`analyze-all error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /analyze-repos ───────────────────────────────────────────────────
  // Body: { threshold?: number, repositories: string[] }
  router.post('/analyze-repos', async (req, res) => {
    const threshold = parseFloat(req.body?.threshold ?? '0.85');
    const repositories: string[] = req.body?.repositories ?? [];

    if (!Array.isArray(repositories) || repositories.length < 2) {
      return res.status(400).json({
        error: 'Select at least 2 GitHub repositories to run cross-repo clone detection.',
      });
    }

    try {
      const servicesPayload = await Promise.all(
        repositories.map(async fullName => {
          const serviceName = fullName;
          const repoUrl = `https://github.com/${fullName}`;
          logger.info(`  Fetching GitHub repo: ${serviceName} <- ${repoUrl}`);
          const files = await fetchCodeFromRepo(repoUrl, reader, logger);
          logger.info(`  ${serviceName}: ${files.length} file(s)`);
          return { service: serviceName, files };
        }),
      );

      const totalFiles = servicesPayload.reduce((n, s) => n + s.files.length, 0);

      try {
        const healthCheck = await fetch(`${CLONE_API_URL}/health`, { method: 'GET' });
        if (!healthCheck.ok) throw new Error('unhealthy');
      } catch {
        return res.status(503).json({
          error: 'Python clone detection API is not running. Start it with: py clone_api.py',
        });
      }

      const cloneResp = await fetch(`${CLONE_API_URL}/detect-clones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold, services: servicesPayload }),
      });

      if (!cloneResp.ok) {
        const errText = await cloneResp.text();
        return res.status(502).json({ error: `Clone API error: ${errText}` });
      }

      const cloneReport = await cloneResp.json();

      return res.json({
        catalog_summary: {
          total_components:       repositories.length,
          components_with_source: repositories.length,
          services_analysed:      servicesPayload.length,
          service_names:          servicesPayload.map(s => s.service),
          total_files_fetched:    totalFiles,
        },
        ...cloneReport,
      });
    } catch (e: any) {
      logger.error(`analyze-repos error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}