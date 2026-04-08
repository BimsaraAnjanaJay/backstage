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
 * Heuristically detects whether a compose service is Java-based.
 *
 * Checks the `image` name for known Java runtime/framework identifiers.
 * Used to choose between Java-agent OTEL injection vs Node.js SDK injection.
 */
function isJavaService(svc: any): boolean {
  const image: string = (svc.image || '').toLowerCase();
  const JAVA_IMAGE_PATTERNS = [
    'eclipse-temurin', 'openjdk', 'amazoncorretto', 'liberica', 'microsoft/java',
    'azul/zulu', 'sapmachine', 'bellsoft', 'ibm-semeru',
    // Spring Boot / Quarkus / other Java framework base images
    'spring', 'quarkus', 'micronaut',
    // Common project-specific images that are Java (detected by author prefix + no node/python)
  ];
  const NODE_IMAGE_PATTERNS = ['node', 'nodejs', 'deno', 'bun'];
  const PYTHON_IMAGE_PATTERNS = ['python', 'pip', 'fastapi', 'flask', 'django'];

  // If it explicitly says node/python, it's not java
  if (NODE_IMAGE_PATTERNS.some(p => image.includes(p))) return false;
  if (PYTHON_IMAGE_PATTERNS.some(p => image.includes(p))) return false;
  if (JAVA_IMAGE_PATTERNS.some(p => image.includes(p))) return true;

  // If it's a custom image (no build context) and entrypoint/command hints at java
  const cmd = String(svc.command || svc.entrypoint || '').toLowerCase();
  if (cmd.includes('java') || cmd.includes('.jar')) return true;

  return false;
}

/** URL to download the OTel Java agent jar */
export const JAVA_AGENT_DOWNLOAD =
  'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

/** Host path where the agent is pre-downloaded and made available to containers */
export const OTEL_AGENT_HOST_PATH = '/tmp/otelcol-agent/opentelemetry-javaagent.jar';

/**
 * Strips bind-mount volumes that reference absolute host paths outside the
 * project directory (e.g. $HOME/Projects/...). These break deployments on
 * machines other than the original developer's.
 *
 * Named volumes (no `:` hostpath component) and relative paths are kept.
 */
function stripExternalVolumes(volumes: any[]): any[] {
  if (!Array.isArray(volumes)) return volumes;
  return volumes.filter(v => {
    const s = String(v);
    // Keep named volumes (no colon) and relative paths (./foo or ../foo)
    if (!s.includes(':')) return true;
    const hostPart = s.split(':')[0];
    if (hostPart.startsWith('./') || hostPart.startsWith('../')) return true;
    // Drop absolute paths and $HOME/... paths — they are machine-specific
    if (hostPart.startsWith('/') || hostPart.startsWith('$')) return false;
    return true;
  });
}

/**
 * Injects OTel into an existing docker-compose file content string.
 *
 * Strategy per service:
 * - **Java** (detected by image name): inject `JAVA_TOOL_OPTIONS=-javaagent`
 *   via environment — NEVER override the command (the JVM picks up the agent automatically).
 * - **Node.js / default**: inject OTEL env vars; add `node otel-server.js` command
 *   only if no existing command is set.
 *
 * Also:
 * - Adds Jaeger to ALL custom networks so every service can reach it.
 * - Strips machine-specific host volume bind-mounts ($HOME/... or absolute paths).
 * - Skips databases, caches, traffic-generators, and Jaeger itself.
 */
export function injectOtelIntoComposeContent(content: string): string {
  const compose: any = yaml.parse(content);
  if (!compose.services) return content;

  // Collect ALL custom networks defined in the compose file (except default bridge)
  const customNetworks: string[] = Object.keys(compose.networks || {}).filter(
    n => n !== 'default',
  );

  // Add Jaeger if not already present, and put it on ALL custom networks
  const hasJaeger = Object.values(compose.services).some((svc: any) =>
    svc.image?.includes('jaeger'),
  );
  if (!hasJaeger) {
    const jaegerSvc: any = {
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
    // Join every custom network so all services can reach Jaeger by hostname
    if (customNetworks.length > 0) {
      jaegerSvc.networks = customNetworks;
    }
    // Avoid port 9411 conflict with Zipkin tracing-server if one is already defined
    const has9411 = Object.values(compose.services).some((svc: any) =>
      Array.isArray(svc.ports) && svc.ports.some((p: any) => String(p).includes('9411')),
    );
    if (has9411) {
      jaegerSvc.ports = jaegerSvc.ports.filter(
        (p: string) => !String(p).includes('9411'),
      );
    }
    compose.services.jaeger = jaegerSvc;
  } else {
    // Ensure existing Jaeger service is on all custom networks
    const jaegerSvc = Object.values(compose.services).find(
      (svc: any) => svc.image?.includes('jaeger'),
    ) as any;
    if (jaegerSvc && customNetworks.length > 0) {
      if (!jaegerSvc.networks) {
        jaegerSvc.networks = customNetworks;
      } else if (Array.isArray(jaegerSvc.networks)) {
        for (const n of customNetworks) {
          if (!jaegerSvc.networks.includes(n)) jaegerSvc.networks.push(n);
        }
      } else if (typeof jaegerSvc.networks === 'object') {
        for (const n of customNetworks) {
          if (!jaegerSvc.networks[n]) jaegerSvc.networks[n] = null;
        }
      }
    }
  }

  // Infrastructure image patterns to skip (monitoring/observability/DB/broker images)
  const INFRA_IMAGES = [
    'jaeger', 'zipkin', 'openzipkin',
    'mongo', 'redis', 'postgres', 'mysql', 'mariadb',
    'rabbitmq', 'kafka', 'zookeeper',
    'elasticsearch', 'kibana',
    'prometheus', 'grafana', 'prom/',
    'nginx', 'haproxy', 'traefik',
  ];

  // Service-name patterns that identify monitoring/observability infra (not business microservices)
  const INFRA_SERVICE_NAMES = [
    'tracingserver', 'zipkin', 'grafanaserver', 'prometheusserver',
    'jaeger', 'adminserver', 'discoveryserver', 'configserver',
  ];

  // Traffic generator service name patterns to skip
  const TRAFFIC_PATTERNS = ['trafficgenerator', 'loadgenerator', 'loadtest'];

  for (const [name, svcRaw] of Object.entries(compose.services)) {
    const svc = svcRaw as any;

    // Skip infrastructure images
    if (INFRA_IMAGES.some(p => svc.image?.toLowerCase().includes(p))) continue;

    // Skip services whose name identifies them as monitoring/observability infra
    const nameNorm = name.toLowerCase().replace(/-/g, '');
    if (INFRA_SERVICE_NAMES.some(p => nameNorm.includes(p))) continue;

    // Skip traffic generators
    if (TRAFFIC_PATTERNS.some(p => nameNorm.includes(p))) continue;

    // Strip machine-specific external volume mounts
    if (Array.isArray(svc.volumes)) {
      svc.volumes = stripExternalVolumes(svc.volumes);
      if (svc.volumes.length === 0) delete svc.volumes;
    }

    // Normalise environment to string-array form, preserving existing vars
    let envList: string[] = [];
    if (Array.isArray(svc.environment)) {
      envList = [...svc.environment];
    } else if (svc.environment && typeof svc.environment === 'object') {
      envList = Object.entries(svc.environment).map(([k, v]) => `${k}=${v}`);
    }

    // Preserve original OTEL_SERVICE_NAME when set by the repo
    const originalServiceName = envList
      .find((e: string) => e.startsWith('OTEL_SERVICE_NAME='))
      ?.split('=')
      .slice(1)
      .join('=');

    // Strip stale OTEL vars so we can re-inject cleanly (also strip NODE_OPTIONS, PORT only for Node)
    envList = envList.filter(
      (e: string) =>
        !e.startsWith('OTEL_') &&
        !e.startsWith('NODE_OPTIONS=') &&
        !e.startsWith('JAVA_TOOL_OPTIONS='),
    );

    const java = isJavaService(svc);

    if (java) {
      // ── Java services ───────────────────────────────────────────────────
      // Strategy: the OTel Java agent is pre-downloaded to the host at
      // OTEL_AGENT_HOST_PATH and bind-mounted into the container at /tmp/otel-agent.jar.
      // JAVA_TOOL_OPTIONS then auto-loads it for ANY java process — including the
      // image's own ENTRYPOINT — with NO command override required.
      envList.push(
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${originalServiceName || name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
        'OTEL_EXPORTER_OTLP_PROTOCOL=grpc',
        'JAVA_TOOL_OPTIONS=-javaagent:/tmp/otel-agent.jar',
      );

      // Bind-mount the pre-downloaded agent from the host.
      // The router ensures the file exists before docker compose up is called.
      if (!svc.volumes) svc.volumes = [];
      // Only add if not already present
      const agentMount = `${OTEL_AGENT_HOST_PATH}:/tmp/otel-agent.jar:ro`;
      if (!svc.volumes.some((v: string) => String(v).includes('otel-agent.jar'))) {
        svc.volumes.push(agentMount);
      }

      // For pre-built images (no command/entrypoint override): leave them completely
      // untouched — JAVA_TOOL_OPTIONS + the volume mount is all we need.
      // Only if the service already has a custom command do we know the startup
      // pattern and can safely wrap it.
    } else {
      // ── Node.js / other services ────────────────────────────────────────
      envList.push(
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${originalServiceName || name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318',
        'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
        'OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process',
      );

      // Inject PORT only when the container uses port 3000 or has no port mapping
      if (!envList.some((e: string) => e.startsWith('PORT='))) {
        let containerPort: string | null = null;
        if (Array.isArray(svc.ports) && svc.ports.length > 0) {
          const parts = String(svc.ports[0]).split(':');
          containerPort = parts[parts.length - 1].split('/')[0];
        }
        if (!containerPort || containerPort === '3000') {
          envList.push('PORT=3000');
        }
      }

      // Only add the otel-server.js startup wrapper when the service has no command.
      // Repos with their own instrumentation (instrument.js, etc.) keep their command.
      if (!svc.command) {
        svc.command = 'node otel-server.js';
      }
    }

    svc.environment = envList;

    // Add Jaeger dependency while preserving existing depends_on
    if (!svc.depends_on) {
      svc.depends_on = ['jaeger'];
    } else if (Array.isArray(svc.depends_on)) {
      if (!svc.depends_on.includes('jaeger')) svc.depends_on.push('jaeger');
    } else if (typeof svc.depends_on === 'object') {
      if (!svc.depends_on.jaeger)
        svc.depends_on.jaeger = { condition: 'service_started' };
    }
  }

  return yaml.stringify(compose, { lineWidth: 0 });
}

