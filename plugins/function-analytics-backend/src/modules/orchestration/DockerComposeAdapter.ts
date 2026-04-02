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

import * as yaml from 'yaml';
import { DiscoveredService } from '../discovery/ServiceDiscoveryEngine';

// ─── Per-language OTEL injection strategies ──────────────────────────────────
//
// Language   | Mechanism                              | Zero-code?
// -----------|----------------------------------------|----------
// nodejs     | --require @opentelemetry/auto-*        | ✅ yes
// typescript | --require @opentelemetry/auto-*        | ✅ yes
// python     | opentelemetry-instrument wrapper       | ✅ yes
// java       | -javaagent:opentelemetry-javaagent.jar | ✅ yes
// ruby       | RUBYOPT -r opentelemetry/auto_instr.   | ✅ yes
// dotnet     | DOTNET_STARTUP_HOOKS + profiler env    | ✅ yes (with distrib.)
// go         | env vars only (manual tracing.go req.) | ⚠️  partial
// rust       | env vars only (manual SDK required)    | ⚠️  partial

/** URL for the official OTel Java auto-instrumentation agent jar */
const JAVA_AGENT_URL =
  'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

/** URL for the OTel .NET auto-instrumentation distribution installer script */
const DOTNET_OTEL_INSTALLER_URL =
  'https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh';

/**
 * Generates a docker-compose.otel.yml that includes Jaeger and
 * per-language OpenTelemetry auto-instrumentation.
 *
 * Supports: nodejs, typescript, python, java, ruby, dotnet, go, rust.
 */
export function generateDockerCompose(services: DiscoveredService[]): string {
  const compose: any = {
    services: {
      jaeger: {
        image: 'jaegertracing/all-in-one:latest',
        container_name: 'jaeger',
        environment: ['COLLECTOR_OTLP_ENABLED=true'],
        ports: [
          '16686:16686',
          '4318:4318',
          '4317:4317',
          '14268:14268',
          '9411:9411',
        ],
        networks: ['microservices'],
      },
    },
    networks: {
      microservices: { driver: 'bridge' },
    },
  };

  for (const service of services) {
    const serviceConfig: any = {
      build: {
        context: `./${service.path}`,
        dockerfile: service.dockerfileName || 'Dockerfile',
      },
      image: `${service.name.toLowerCase()}:latest`,
      container_name: service.name.toLowerCase(),
      environment: [
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${service.name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
      ],
      ports: [`${service.port}:${service.port}`],
      depends_on: ['jaeger'],
      networks: ['microservices'],
    };

    applyOtelInjection(serviceConfig, service);

    compose.services[service.name] = serviceConfig;
  }

  return yaml.stringify(compose, { lineWidth: 0 });
}

/**
 * Mutates `serviceConfig` to add the OTEL environment variables and startup
 * command wrapper appropriate for the service's language.
 */
function applyOtelInjection(
  serviceConfig: any,
  service: DiscoveredService,
): void {
  const lang = service.language;

  // ── Node.js & TypeScript ────────────────────────────────────────────────────
  if (lang === 'nodejs' || lang === 'typescript') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318',
      'OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process',
    );
    const entrypoint = service.entrypoint || 'index.js';
    serviceConfig.command =
      `sh -c "npm install && ` +
      `npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node && ` +
      `node --require @opentelemetry/auto-instrumentations-node/register ${entrypoint}"`;
    return;
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  if (lang === 'python') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
    );
    const entrypoint = service.entrypoint || 'main.py';
    serviceConfig.command =
      `sh -c "pip install --quiet opentelemetry-distro opentelemetry-exporter-otlp && ` +
      `opentelemetry-bootstrap -a install && ` +
      `opentelemetry-instrument python ${entrypoint}"`;
    return;
  }

  // ── Java ─────────────────────────────────────────────────────────────────────
  // Uses the official OpenTelemetry Java agent for zero-code auto-instrumentation.
  // Downloads the agent at container start, then runs the app jar via JAVA_TOOL_OPTIONS.
  if (lang === 'java') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
    );
    // When a known jar path was detected at scan time, use it directly.
    // Otherwise search common container paths at runtime.
    const jarClause = service.entrypoint
      ? `${service.entrypoint}`
      : `$(find /app /service /usr/app . -name '*.jar' 2>/dev/null | grep -v 'otel\\|agent\\|sources\\|javadoc' | head -1)`;
    serviceConfig.command =
      `sh -c "wget -qO /tmp/otel-agent.jar '${JAVA_AGENT_URL}' 2>/dev/null || ` +
      `curl -sLo /tmp/otel-agent.jar '${JAVA_AGENT_URL}'; ` +
      `exec java -javaagent:/tmp/otel-agent.jar -jar ${jarClause}"`;
    return;
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────────
  // Uses RUBYOPT to require the opentelemetry auto-instrumentation library
  // without any code changes to the application.
  if (lang === 'ruby') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      'RUBYOPT=-r opentelemetry/auto_instrumentation',
    );
    const entrypoint = service.entrypoint || 'app.rb';
    // config.ru = Rack app — use rackup; otherwise use bundle exec ruby
    const runCmd =
      entrypoint === 'config.ru'
        ? `bundle exec rackup ${entrypoint} -p ${service.port}`
        : `bundle exec ruby ${entrypoint}`;
    serviceConfig.command =
      `sh -c "bundle install --quiet 2>/dev/null; ` +
      `gem install --quiet opentelemetry-sdk opentelemetry-exporter-otlp ` +
      `opentelemetry-instrumentation-all 2>/dev/null; ` +
      `exec ${runCmd}"`;
    return;
  }

  // ── .NET (C#, F#, VB) ────────────────────────────────────────────────────────
  // Downloads and runs the official OTel .NET auto-instrumentation installer,
  // then sets the required profiler environment variables before running the app.
  if (lang === 'dotnet') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      'OTEL_DOTNET_AUTO_HOME=/otel-dotnet-auto',
      'CORECLR_ENABLE_PROFILING=1',
      'CORECLR_PROFILER={918728DD-259F-4A6A-AC2B-B85E1B658318}',
      'CORECLR_PROFILER_PATH=/otel-dotnet-auto/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so',
      'DOTNET_ADDITIONAL_DEPS=/otel-dotnet-auto/AdditionalDeps',
      'DOTNET_STARTUP_HOOKS=/otel-dotnet-auto/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll',
      'DOTNET_SHARED_STORE=/otel-dotnet-auto/store',
    );
    // `service.entrypoint` holds the project name (without .csproj extension)
    const runCmd = service.entrypoint
      ? `dotnet run --project ${service.entrypoint}`
      : 'dotnet run';
    serviceConfig.command =
      `sh -c "curl -sSfLo /tmp/otel-install.sh '${DOTNET_OTEL_INSTALLER_URL}' && ` +
      `OTEL_DOTNET_AUTO_HOME=/otel-dotnet-auto sh /tmp/otel-install.sh && ` +
      `. /otel-dotnet-auto/instrument.sh && ` +
      `exec ${runCmd}"`;
    return;
  }

  // ── Go ────────────────────────────────────────────────────────────────────────
  // Go has no zero-code auto-instrumentation. Set env vars so manual OTel SDK
  // usage (via a generated tracing.go) can read them at runtime.
  if (lang === 'go') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
    );
    // No command override — rely on the Dockerfile's CMD/ENTRYPOINT.
    return;
  }

  // ── Rust ─────────────────────────────────────────────────────────────────────
  // Rust also has no zero-code auto-instrumentation. Set env vars for manual use.
  if (lang === 'rust') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
    );
    return;
  }

  // Unknown language — set generic OTLP endpoint only
  serviceConfig.environment.push(
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
  );
}

/**
 * Injects OTel detector bypass and corrects the OTLP endpoint path in an
 * existing docker-compose file content string.
 *
 * Used when a repo ships its own docker-compose.yml and we overlay OTEL config.
 * Preserves original port mappings, volumes, depends_on, and environment variables.
 * Adds Jaeger, injects OTEL env vars, and wraps startup command with OTEL SDK install.
 */
export function injectOtelIntoComposeContent(content: string): string {
  const compose: any = yaml.parse(content);
  if (!compose.services) return content;

  // Add Jaeger if not already present (uses default network — visible to all services)
  const hasJaeger = Object.values(compose.services).some((svc: any) =>
    svc.image?.includes('jaeger'),
  );
  if (!hasJaeger) {
    compose.services.jaeger = {
      image: 'jaegertracing/all-in-one:latest',
      container_name: 'jaeger',
      environment: ['COLLECTOR_OTLP_ENABLED=true'],
      ports: [
        '16686:16686',
        '4318:4318',
        '4317:4317',
        '14268:14268',
        '9411:9411',
      ],
    };
  }

  for (const [name, svcRaw] of Object.entries(compose.services)) {
    const svc = svcRaw as any;
    // Skip infrastructure images — do not inject OTEL into databases, caches, etc.
    if (
      svc.image?.includes('jaeger') ||
      svc.image?.includes('mongo') ||
      svc.image?.includes('redis') ||
      svc.image?.includes('postgres') ||
      svc.image?.includes('mysql')
    )
      continue;

    // Normalise environment to string-array form, preserving existing vars
    let envList: string[] = [];
    if (Array.isArray(svc.environment)) {
      envList = [...svc.environment];
    } else if (svc.environment && typeof svc.environment === 'object') {
      envList = Object.entries(svc.environment).map(([k, v]) => `${k}=${v}`);
    }
    // Preserve original OTEL_SERVICE_NAME if present — repos like lightweight-otel-demo
    // ship their own meaningful name (e.g. "auth-service") which is better than the raw
    // compose service key ("auth"). Fall back to the compose key when not set.
    const originalServiceName = envList
      .find((e: string) => e.startsWith('OTEL_SERVICE_NAME='))
      ?.split('=')
      .slice(1)
      .join('=');

    // Strip stale OTEL vars so we can re-inject cleanly
    envList = envList.filter(
      (e: string) => !e.startsWith('OTEL_') && !e.startsWith('NODE_OPTIONS='),
    );
    envList.push(
      'OTEL_TRACES_EXPORTER=otlp',
      `OTEL_SERVICE_NAME=${originalServiceName || name}`,
      'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
      // Port 4318 is the OTLP HTTP endpoint; must match the protocol below
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318',
      // Explicitly set HTTP/protobuf so the SDK doesn't default to gRPC (port 4317)
      'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
      'OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process',
    );

    // Add Jaeger dependency while preserving existing depends_on (e.g. mongo-db)
    if (!svc.depends_on) {
      svc.depends_on = ['jaeger'];
    } else if (Array.isArray(svc.depends_on)) {
      if (!svc.depends_on.includes('jaeger')) svc.depends_on.push('jaeger');
    } else if (typeof svc.depends_on === 'object') {
      if (!svc.depends_on.jaeger)
        svc.depends_on.jaeger = { condition: 'service_started' };
    }

    // Only inject PORT if the service doesn't already have one in its environment.
    // Derive the container-side port from the compose port mapping (HOST:CONTAINER format).
    // This avoids overriding services that bind to non-3000 ports (e.g. 8080, 8082).
    if (!envList.some((e: string) => e.startsWith('PORT='))) {
      let containerPort: string | null = null;
      if (Array.isArray(svc.ports) && svc.ports.length > 0) {
        // Port mappings can be "HOST:CONTAINER" strings or numeric values
        const firstPort = String(svc.ports[0]);
        const parts = firstPort.split(':');
        containerPort = parts[parts.length - 1].split('/')[0]; // strip /tcp if present
      }
      // Only inject PORT=3000 when no port mapping exists (no compose ports defined)
      // or when the container port is explicitly 3000. For other ports, the service
      // already knows its own port — don't override it.
      if (!containerPort || containerPort === '3000') {
        envList.push('PORT=3000');
      }
    }
    svc.environment = envList;

    // Startup: use the original command when present (repos with own OTEL setup like
    // lightweight-otel-demo using instrument.js), or fall back to node otel-server.js
    // for repos like RajGM/Microservice where ServerWrapperGenerator creates the wrapper.
    // OTEL packages are now installed at build time by DockerfileFixerAdapter, so no
    // runtime npm install is needed here.
    if (!svc.command) {
      svc.command = 'node otel-server.js';
    }
    // If a command already exists, preserve it unchanged.
  }

  return yaml.stringify(compose, { lineWidth: 0 });
}
