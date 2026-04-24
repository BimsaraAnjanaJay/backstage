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

import * as fs from 'fs';
import * as path from 'path';
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
  // @opentelemetry/auto-instrumentations-node covers http, express, grpc, dns, etc.
  // OTEL_NODE_ENABLED_INSTRUMENTATIONS limits to HTTP + express to reduce noise
  // while still capturing inter-service calls.
  // OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT raised to capture fra.* custom attributes.
  if (lang === 'nodejs' || lang === 'typescript') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318',
      'OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process',
      'OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,express,fastify,koa,hapi,grpc',
      'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=64',
      // Disable @google-cloud/profiler — its native pprof binary fails on
      // newer Node.js versions and crashes services before OTel can load.
      'DISABLE_PROFILER=1',
    );
    const entrypoint = service.entrypoint || 'index.js';
    serviceConfig.command =
      `sh -c "npm install && ` +
      `npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node && ` +
      `node --require @opentelemetry/auto-instrumentations-node/register ${entrypoint}"`;
    return;
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  // opentelemetry-instrument wraps the app with zero-code auto-instrumentation.
  // OTEL_PYTHON_DISABLED_INSTRUMENTATIONS reduces framework noise (urllib, requests
  // internal calls) so that app-level function spans are cleaner.
  // OTEL_PYTHON_LOG_LEVEL=warning silences SDK setup spam.
  if (lang === 'python') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      'OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=urllib,urllib3,requests',
      'OTEL_PYTHON_LOG_LEVEL=warning',
    );
    const entrypoint = service.entrypoint || 'main.py';
    // Detect whether this is a FastAPI/uvicorn app or a plain Flask/Python app
    const isUvicorn = entrypoint.endsWith('.py');
    const runCmd = isUvicorn
      ? `opentelemetry-instrument python -m uvicorn ${entrypoint.replace(
          '.py',
          '',
        )}:app --host 0.0.0.0 --port ${
          service.port
        } 2>/dev/null || opentelemetry-instrument python ${entrypoint}`
      : `opentelemetry-instrument python ${entrypoint}`;
    serviceConfig.command =
      `sh -c "pip install --quiet opentelemetry-distro opentelemetry-exporter-otlp uvicorn fastapi 2>/dev/null; ` +
      `opentelemetry-bootstrap -a install 2>/dev/null; ` +
      `${runCmd}"`;
    return;
  }

  // ── Java ─────────────────────────────────────────────────────────────────────
  // Uses the official OpenTelemetry Java agent for zero-code auto-instrumentation.
  // Downloads the agent at container start, then runs the app jar via JAVA_TOOL_OPTIONS.
  //
  // OTEL_INSTRUMENTATION_METHODS_INCLUDE tells the Java agent to create spans for
  // every method in user-defined application packages, giving function-level visibility.
  // Pattern: "com.example.*[*]" matches all methods in all classes under com.example.
  //
  // We derive the package glob from the service name — e.g. "user-service" becomes
  // "com.*.userservice.*[*]" and "fra.hostjava.*[*]" as fallback wildcards.
  // The wildcard form "[*]" captures all methods in matched classes.
  if (lang === 'java') {
    // Use broad fallback patterns — applyOtelInjection doesn't have the repo root,
    // so patchOtelMethodsInclude() will refine these after compose file generation.
    const appPackageGlob = buildJavaMethodsInclude([]);

    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      // Function-level spans: instrument all methods under user app packages
      `OTEL_INSTRUMENTATION_METHODS_INCLUDE=${appPackageGlob}`,
      // Reduce framework noise — keep only core HTTP + manual instrumentation
      'OTEL_INSTRUMENTATION_COMMON_EXPERIMENTAL_CONTROLLER_TELEMETRY_ENABLED=true',
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
  // usage can read them at runtime.
  //
  // IMPORTANT: Go OTel SDK v1.42+ interprets OTEL_EXPORTER_OTLP_ENDPOINT with
  // an "http://" scheme as OTLP/HTTP transport (port 4318).  When set to
  // "http://jaeger:4317", the SDK switches to HTTP and fails against the gRPC-only
  // port — silently dropping all spans.  Use the bare "host:port" form (no scheme)
  // so the SDK defaults to gRPC transport on port 4317.
  //
  // Also add COLLECTOR_SERVICE_ADDR + ENABLE_TRACING for repos (like Google
  // Online Boutique) whose Go services read those vars instead of the OTel spec vars.
  if (lang === 'go') {
    serviceConfig.environment.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT=jaeger:4317',
      'COLLECTOR_SERVICE_ADDR=jaeger:4317',
      'ENABLE_TRACING=1',
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
function isJavaService(svc: any, repoRoot?: string): boolean {
  const image: string = (svc.image || '').toLowerCase();
  const JAVA_IMAGE_PATTERNS = [
    'eclipse-temurin',
    'openjdk',
    'amazoncorretto',
    'liberica',
    'microsoft/java',
    'azul/zulu',
    'sapmachine',
    'bellsoft',
    'ibm-semeru',
    // Spring Boot / Quarkus / other Java framework base images
    'spring',
    'quarkus',
    'micronaut',
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

  // Detect Java via Spring/Quarkus environment variables present on the service
  const envVars: string[] = Array.isArray(svc.environment)
    ? svc.environment.map(String)
    : Object.keys(svc.environment || {});
  const javaEnvPrefixes = [
    'SPRING_',
    'QUARKUS_',
    'MICRONAUT_',
    'JAVA_',
    'HELIDON_',
  ];
  if (
    envVars.some(e => javaEnvPrefixes.some(p => e.toUpperCase().startsWith(p)))
  )
    return true;

  // Filesystem fallback: when the image name is opaque (e.g. uses ${VAR} templates
  // like "${IMG_REPO}/ts-auth-service:${IMG_TAG}") we cannot determine language from
  // the name alone.  If we have the repo root, check the build context directory for
  // Java project files (pom.xml, build.gradle, settings.gradle, *.java).
  if (repoRoot && svc.build) {
    const buildCtx =
      typeof svc.build === 'string' ? svc.build : svc.build?.context || '.';
    // Only resolve relative paths — absolute paths are machine-specific
    if (!path.isAbsolute(buildCtx)) {
      const absCtx = path.join(repoRoot, buildCtx);
      const javaIndicators = [
        'pom.xml',
        'build.gradle',
        'build.gradle.kts',
        'settings.gradle',
        'settings.gradle.kts',
      ];
      if (javaIndicators.some(f => fs.existsSync(path.join(absCtx, f))))
        return true;
      // Also check for any .java source file one level deep (src/main/java/...)
      const srcMain = path.join(absCtx, 'src', 'main', 'java');
      if (fs.existsSync(srcMain)) return true;
    }
  }

  return false;
}

/**
 * Positively identifies a service as Go.
 * Checks the build context for go.mod/go.sum, or looks for golang in the image name.
 */
function isGoService(svc: any, repoRoot?: string): boolean {
  const image: string = (svc.image || '').toLowerCase();
  if (image.includes('golang') || image.includes('distroless/go')) return true;

  const cmd = String(svc.command || svc.entrypoint || '').toLowerCase();
  if (cmd.startsWith('go run') || cmd.startsWith('go build')) return true;

  if (repoRoot && svc.build) {
    const buildCtx =
      typeof svc.build === 'string' ? svc.build : svc.build?.context || '.';
    if (!path.isAbsolute(buildCtx)) {
      const absCtx = path.join(repoRoot, buildCtx);
      if (
        fs.existsSync(path.join(absCtx, 'go.mod')) ||
        fs.existsSync(path.join(absCtx, 'go.sum'))
      )
        return true;
    }
  }
  return false;
}

/**
 * Positively identifies a service as Node.js.
 * Only returns true when we have clear evidence — image name, build-context
 * package.json, or an existing node/npm command. Unknown pre-built images
 * are NOT assumed to be Node.js.
 */
function isNodeService(svc: any, repoRoot?: string): boolean {
  const image: string = (svc.image || '').toLowerCase();
  const NODE_IMAGE_PATTERNS = ['node', 'nodejs', 'deno', 'bun'];
  if (NODE_IMAGE_PATTERNS.some(p => image.includes(p))) return true;

  const cmd = String(svc.command || svc.entrypoint || '').toLowerCase();
  if (
    cmd.startsWith('node ') ||
    cmd.startsWith('npm ') ||
    cmd.startsWith('yarn ') ||
    cmd.startsWith('pnpm ') ||
    cmd.includes('nodemon')
  )
    return true;

  // Filesystem fallback: check build context for package.json
  if (repoRoot && svc.build) {
    const buildCtx =
      typeof svc.build === 'string' ? svc.build : svc.build?.context || '.';
    if (!path.isAbsolute(buildCtx)) {
      const absCtx = path.join(repoRoot, buildCtx);
      if (fs.existsSync(path.join(absCtx, 'package.json'))) return true;
    }
  }

  return false;
}

/** URL to download the OTel Java agent jar */
export const JAVA_AGENT_DOWNLOAD =
  'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

/** Host path where the agent is pre-downloaded and made available to containers */
// Store the agent under the user's home directory so it's always in Docker's
// default file-sharing scope (~/... is shared by Docker Desktop on Mac/Windows/Linux).
export const OTEL_AGENT_HOST_PATH = `${
  process.env.HOME || '/home/ucsc'
}/.fra-otel-agent/opentelemetry-javaagent.jar`;

/**
 * Detects Java root package prefixes by scanning `src/main/java/` in the given
 * build context directory.
 *
 * For example, if the directory contains `src/main/java/auth/` and
 * `src/main/java/user/`, this returns `['auth', 'user']`.
 *
 * These are used as a fallback when no fully-qualified class names can be
 * extracted (e.g. source code is unavailable).
 */
export function detectJavaRootPackages(buildCtxDir: string): string[] {
  const srcMainJava = path.join(buildCtxDir, 'src', 'main', 'java');
  if (!fs.existsSync(srcMainJava)) return [];
  try {
    return fs
      .readdirSync(srcMainJava, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-z]/.test(d.name))
      .map(d => d.name)
      .slice(0, 6);
  } catch {
    return [];
  }
}

// Maximum class entries to include — avoids env-var length issues.
const MAX_JAVA_CLASSES = 60;

const JAVA_SCAN_SKIP_DIRS = new Set([
  'test',
  'tests',
  'it',
  'node_modules',
  '.git',
  'target',
  'build',
  'out',
  '__pycache__',
]);

/**
 * Java contextual keywords that can appear after `class|interface|enum` but
 * are not valid class names (Java 9+ module system, preview features, etc.).
 */
const JAVA_CONTEXTUAL_KEYWORDS = new Set([
  'provides',
  'requires',
  'exports',
  'opens',
  'uses',
  'with',
  'to',
  'module',
  'open',
  'transitive',
  'permits',
  'sealed',
  'record',
  'yield',
]);

/** Method names that are always boilerplate and should not be instrumented. */
const SKIP_METHOD_NAMES = new Set([
  'toString',
  'hashCode',
  'equals',
  'clone',
  'finalize',
  'getClass',
  'notify',
  'notifyAll',
  'wait',
  'main',
  'run',
  'init',
  'destroy',
  'afterPropertiesSet',
  'postProcessBeforeInitialization',
  'postProcessAfterInitialization',
  'postProcessBeforeDestruction',
  'getBean',
  'getApplicationContext',
]);

/** Extracted class with its callable methods. */
export interface JavaClassEntry {
  fqcn: string;
  methods: string[];
}

/**
 * Reads a Java source file and extracts:
 * - Fully-qualified class name (package + first class/interface/enum name)
 * - Public and protected non-constructor method names
 *
 * The OTel Java agent v2.x requires specific method names in
 * `OTEL_INSTRUMENTATION_METHODS_INCLUDE` — the `[*]` wildcard fails the
 * agent's format validation because `*` is not a word character in `\w+`.
 *
 * Returns undefined when the class name cannot be extracted.
 */
function extractJavaClassEntry(filePath: string): JavaClassEntry | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  // Strip single-line and block comments to avoid false matches
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const pkgMatch = stripped.match(/^\s*package\s+([\w.]+)\s*;/m);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  const classMatch = stripped.match(/\b(?:class|interface|enum)\s+(\w+)/m);
  if (!classMatch) return undefined;

  const className = classMatch[1];
  // Skip entries where the extracted "class name" is a Java contextual keyword
  if (JAVA_CONTEXTUAL_KEYWORDS.has(className)) return undefined;
  // Class names start with an uppercase letter; skip anything else
  if (!/^[A-Z]/.test(className)) return undefined;

  const fqcn = pkg ? `${pkg}.${className}` : className;

  // Extract public/protected non-constructor method names.
  // Pattern: visibility modifier (optional), optional modifiers, return type, methodName(
  const methodRe =
    /(?:^|[\n;{}])\s*(?:public|protected)\s+(?:(?:static|final|synchronized|default|abstract)\s+)*(?!class\b|interface\b|enum\b)[\w<>\[\],.\s]+\s+(\w+)\s*\(/gm;

  const methods: string[] = [];
  for (const m of stripped.matchAll(methodRe)) {
    const name = m[1];
    // Skip constructors (same name as class) and boilerplate
    if (name === className) continue;
    if (SKIP_METHOD_NAMES.has(name)) continue;
    // Skip getter/setter boilerplate (get*/set*/is* with 3+ length heuristic)
    if (/^(?:get|set|is)[A-Z]/.test(name)) continue;
    methods.push(name);
  }

  return { fqcn, methods: [...new Set(methods)] };
}

function collectJavaClassEntries(
  dir: string,
  results: JavaClassEntry[],
  depth = 0,
): void {
  if (depth > 12 || results.length >= MAX_JAVA_CLASSES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_JAVA_CLASSES) break;
    if (entry.isDirectory()) {
      if (!JAVA_SCAN_SKIP_DIRS.has(entry.name)) {
        collectJavaClassEntries(path.join(dir, entry.name), results, depth + 1);
      }
    } else if (entry.name.endsWith('.java')) {
      const ce = extractJavaClassEntry(path.join(dir, entry.name));
      if (ce && ce.methods.length > 0) results.push(ce);
    }
  }
}

/**
 * Scans `src/main/java/` in `buildCtxDir` and returns class entries (FQCN +
 * method names) for all application classes that have instrumentation-worthy
 * public/protected methods.
 *
 * The OTel Java agent v2.x validates each entry in
 * `OTEL_INSTRUMENTATION_METHODS_INCLUDE` against a `\w+` method-name pattern,
 * which does NOT match the `*` wildcard. Real method names are required.
 */
export function detectJavaApplicationClasses(
  buildCtxDir: string,
): JavaClassEntry[] {
  const srcMainJava = path.join(buildCtxDir, 'src', 'main', 'java');
  if (!fs.existsSync(srcMainJava)) return [];
  const results: JavaClassEntry[] = [];
  collectJavaClassEntries(srcMainJava, results);
  return results;
}

/**
 * Resolves the Java source directory for a service.
 *
 * Priority:
 *   1. Build context from the compose service definition (most accurate).
 *   2. Subdirectory of `repoRoot` whose name matches `serviceName` — handles
 *      pre-built-image repos (e.g. `image: sqshq/piggymetrics-account-service`)
 *      where there is no `build` context but source lives at `account-service/`.
 *
 * Returns undefined when no source directory can be located.
 */
function resolveJavaSourceDir(
  svc: any,
  serviceName: string,
  repoRoot?: string,
): string | undefined {
  let buildCtx: string | undefined;
  if (svc.build) {
    buildCtx = typeof svc.build === 'string' ? svc.build : svc.build?.context;
  }

  if (buildCtx && repoRoot && !path.isAbsolute(buildCtx)) {
    return path.join(repoRoot, buildCtx);
  }
  if (buildCtx && path.isAbsolute(buildCtx)) {
    return buildCtx;
  }
  // No build context — try service-name subdirectory (pre-built image repos)
  if (repoRoot) {
    const byName = path.join(repoRoot, serviceName);
    if (fs.existsSync(byName)) return byName;
  }
  return undefined;
}

/**
 * Builds the `OTEL_INSTRUMENTATION_METHODS_INCLUDE` value for a Java service.
 *
 * When class entries (FQCN + method names) are provided, generates
 * `ClassName[method1,method2,...]` entries — the only form the OTel Java agent
 * v2.x accepts. The agent's format validation requires `\w+` method names;
 * the `[*]` wildcard fails validation because `*` ∉ `\w`.
 *
 * Falls back to root-package prefix patterns (e.g. `com.example.*[create]`)
 * when no class entries are available and source cannot be scanned.
 */
export function buildJavaMethodsInclude(
  detectedPkgs: string[],
  classEntries?: JavaClassEntry[],
): string {
  if (classEntries && classEntries.length > 0) {
    return classEntries
      .filter(ce => ce.methods.length > 0)
      .map(ce => `${ce.fqcn}[${ce.methods.join(',')}]`)
      .join(';');
  }
  if (detectedPkgs.length === 0) {
    // Broad fallback — wildcards in class names are not supported by the agent
    // in v2.x, but kept as a last-resort for older agent versions.
    return 'fra.*[*];com.*[*];org.*[*];io.*[*];cn.*[*];net.*[*]';
  }
  const pkgs = [...new Set(['fra', ...detectedPkgs])];
  return pkgs.map(p => `${p}.*[*]`).join(';');
}

/**
 * Reads the given docker-compose file, detects Java package prefixes for each
 * Java service from its build context, and patches OTEL_INSTRUMENTATION_METHODS_INCLUDE
 * to cover those packages. Writes the updated compose back to disk if any
 * service needed updating.
 *
 * Called after the compose file is finalized (whether pre-existing or generated)
 * to ensure method-level spans cover the service's actual package namespaces.
 */
export function patchOtelMethodsInclude(
  composePath: string,
  repoRoot: string,
): void {
  if (!fs.existsSync(composePath)) return;
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    const compose: any = yaml.parse(content);
    if (!compose?.services) return;

    let changed = false;
    for (const [svcName, svcRaw] of Object.entries(compose.services)) {
      const svc = svcRaw as any;
      if (!svc?.environment) continue;

      // Identify Java services: either via JAVA_TOOL_OPTIONS (injectOtelIntoComposeContent)
      // or via OTEL_INSTRUMENTATION_METHODS_INCLUDE (generateDockerCompose).
      const envList: string[] = Array.isArray(svc.environment)
        ? [...svc.environment]
        : Object.entries(svc.environment || {}).map(([k, v]) => `${k}=${v}`);

      const hasJavaOtelEnv =
        envList.some((e: string) => e.startsWith('JAVA_TOOL_OPTIONS=')) ||
        envList.some((e: string) =>
          e.startsWith('OTEL_INSTRUMENTATION_METHODS_INCLUDE='),
        );
      if (!hasJavaOtelEnv) continue;

      // Resolve source directory: build context or service-name fallback for pre-built images.
      const sourceDir = resolveJavaSourceDir(svc, svcName, repoRoot);
      if (!sourceDir) continue;

      // Prefer class entries (FQCN + methods); fall back to root-package prefixes.
      const classEntries = detectJavaApplicationClasses(sourceDir);
      const detectedPkgs =
        classEntries.length === 0 ? detectJavaRootPackages(sourceDir) : [];
      if (classEntries.length === 0 && detectedPkgs.length === 0) continue;

      const newMethodsInclude = buildJavaMethodsInclude(
        detectedPkgs,
        classEntries.length > 0 ? classEntries : undefined,
      );

      const currentIdx = envList.findIndex((e: string) =>
        e.startsWith('OTEL_INSTRUMENTATION_METHODS_INCLUDE='),
      );
      const currentVal =
        currentIdx >= 0
          ? envList[currentIdx].split('=').slice(1).join('=')
          : '';

      // Skip update when the current value already covers all detected classes.
      if (classEntries.length > 0) {
        const alreadyCovered = classEntries.every(ce =>
          currentVal.includes(ce.fqcn),
        );
        if (alreadyCovered && currentIdx >= 0) continue;
      } else {
        const alreadyCovered = detectedPkgs.every(pkg =>
          currentVal.includes(`${pkg}.*[*]`),
        );
        if (alreadyCovered && currentIdx >= 0) continue;
      }

      if (currentIdx >= 0) {
        envList[
          currentIdx
        ] = `OTEL_INSTRUMENTATION_METHODS_INCLUDE=${newMethodsInclude}`;
      } else {
        envList.push(
          `OTEL_INSTRUMENTATION_METHODS_INCLUDE=${newMethodsInclude}`,
        );
      }
      svc.environment = envList;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(
        composePath,
        yaml.stringify(compose, { lineWidth: 0 }),
        'utf-8',
      );
    }
  } catch {
    // Non-fatal — proceed without patching
  }
}

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
export function injectOtelIntoComposeContent(
  content: string,
  repoRoot?: string,
): string {
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
    const has9411 = Object.values(compose.services).some(
      (svc: any) =>
        Array.isArray(svc.ports) &&
        svc.ports.some((p: any) => String(p).includes('9411')),
    );
    if (has9411) {
      jaegerSvc.ports = jaegerSvc.ports.filter(
        (p: string) => !String(p).includes('9411'),
      );
    }
    compose.services.jaeger = jaegerSvc;
  } else {
    // Ensure existing Jaeger service is on all custom networks
    const jaegerSvc = Object.values(compose.services).find((svc: any) =>
      svc.image?.includes('jaeger'),
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
    'jaeger',
    'zipkin',
    'openzipkin',
    'mongo',
    'redis',
    'postgres',
    'mysql',
    'mariadb',
    'rabbitmq',
    'kafka',
    'zookeeper',
    'elasticsearch',
    'kibana',
    'prometheus',
    'grafana',
    'prom/',
    'nginx',
    'haproxy',
    'traefik',
  ];

  // Service-name patterns that identify monitoring/observability infra (not business microservices)
  const INFRA_SERVICE_NAMES = [
    'tracingserver',
    'zipkin',
    'grafanaserver',
    'prometheusserver',
    'jaeger',
    'adminserver',
    'discoveryserver',
    'configserver',
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

    const java = isJavaService(svc, repoRoot);
    const go = !java && isGoService(svc, repoRoot);

    if (go) {
      // ── Go services ─────────────────────────────────────────────────────────
      // Go OTel SDK v1.42+ treats "http://host:port" in OTEL_EXPORTER_OTLP_ENDPOINT
      // as OTLP/HTTP transport — sending to the gRPC-only port 4317 silently drops
      // all spans.  Use bare "host:port" so the SDK defaults to gRPC transport.
      // Also inject COLLECTOR_SERVICE_ADDR + ENABLE_TRACING for repos (like Google
      // Online Boutique) whose services read those vars instead of the OTel spec vars.
      envList.push(
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${originalServiceName || name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
        'OTEL_EXPORTER_OTLP_ENDPOINT=jaeger:4317',
        'OTEL_EXPORTER_OTLP_PROTOCOL=grpc',
        'COLLECTOR_SERVICE_ADDR=jaeger:4317',
        'ENABLE_TRACING=1',
      );
      // No command override and no JAVA_TOOL_OPTIONS — Go ignores JVM env vars.
    } else if (java) {
      // ── Java services ───────────────────────────────────────────────────
      // Strategy: the OTel Java agent is pre-downloaded to the host at
      // OTEL_AGENT_HOST_PATH and bind-mounted into the container at /tmp/otel-agent.jar.
      // JAVA_TOOL_OPTIONS then auto-loads it for ANY java process — including the
      // image's own ENTRYPOINT — with NO command override required.
      // OTEL_INSTRUMENTATION_METHODS_INCLUDE tells the Java agent to instrument
      // specific application classes. Exact fully-qualified class names are
      // required — package wildcards (com.*[*]) are silently ignored by the agent.
      // Source dir is found via build context or service-name subdirectory fallback.
      const javaSourceDir = resolveJavaSourceDir(svc, name, repoRoot);
      const classEntries = javaSourceDir
        ? detectJavaApplicationClasses(javaSourceDir)
        : [];
      const detectedPkgs =
        !classEntries.length && javaSourceDir
          ? detectJavaRootPackages(javaSourceDir)
          : [];
      const javaMethodsInclude = buildJavaMethodsInclude(
        detectedPkgs,
        classEntries.length > 0 ? classEntries : undefined,
      );
      envList.push(
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${originalServiceName || name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
        'OTEL_EXPORTER_OTLP_PROTOCOL=grpc',
        `OTEL_INSTRUMENTATION_METHODS_INCLUDE=${javaMethodsInclude}`,
        'JAVA_TOOL_OPTIONS=-javaagent:/tmp/otel-agent.jar',
      );

      // Bind-mount the pre-downloaded agent from the host.
      // The router ensures the file exists before docker compose up is called.
      if (!svc.volumes) svc.volumes = [];
      // Only add if not already present
      const agentMount = `${OTEL_AGENT_HOST_PATH}:/tmp/otel-agent.jar:ro`;
      if (
        !svc.volumes.some((v: string) => String(v).includes('otel-agent.jar'))
      ) {
        svc.volumes.push(agentMount);
      }

      // For pre-built images (no command/entrypoint override): leave them completely
      // untouched — JAVA_TOOL_OPTIONS + the volume mount is all we need.
      // Only if the service already has a custom command do we know the startup
      // pattern and can safely wrap it.
    } else if (isNodeService(svc, repoRoot)) {
      // ── Confirmed Node.js services ──────────────────────────────────────
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

      // Inject the OTel auto-instrumentation require flag when the service has no
      // command of its own.  We detect the entrypoint from package.json so the
      // command is correct for any Node.js repo layout (index.js, server.js, etc.).
      if (!svc.command) {
        let entrypoint = 'index.js';
        let buildCtxNode = '.';
        if (svc.build) {
          buildCtxNode =
            typeof svc.build === 'string'
              ? svc.build
              : svc.build?.context || '.';
        }
        if (repoRoot && !path.isAbsolute(buildCtxNode)) {
          try {
            const pkgRaw = fs.readFileSync(
              path.join(repoRoot, buildCtxNode, 'package.json'),
              'utf-8',
            );
            const pkg = JSON.parse(pkgRaw);
            entrypoint = pkg.main || 'index.js';
          } catch {
            /* best-effort — fall back to index.js */
          }
        }
        svc.command =
          `sh -c "npm install --no-save @opentelemetry/api ` +
          `@opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node 2>/dev/null; ` +
          `node --require @opentelemetry/auto-instrumentations-node/register ${entrypoint}"`;
      } else if (
        typeof svc.command === 'string' &&
        !svc.command.includes('--require') &&
        !svc.command.includes('opentelemetry-instrument')
      ) {
        // Wrap existing plain "node <entrypoint>" commands with the --require flag.
        svc.command = svc.command.replace(
          /\bnode\s+((?!--require)[^\s])/,
          'node --require @opentelemetry/auto-instrumentations-node/register $1',
        );
      }
    } else {
      // ── Unknown / pre-built image (language not determinable) ───────────
      // Default to Java-agent injection: JAVA_TOOL_OPTIONS is a JVM-specific
      // environment variable — non-Java runtimes ignore it entirely, so this
      // is safe for Go, Python, Rust, etc. while still instrumenting any JVM
      // service that doesn't match the explicit Java patterns above.
      // NEVER override the command here — we don't know the runtime.
      const unkSourceDir = resolveJavaSourceDir(svc, name, repoRoot);
      const unkClassEntries = unkSourceDir
        ? detectJavaApplicationClasses(unkSourceDir)
        : [];
      const detectedPkgsUnk =
        !unkClassEntries.length && unkSourceDir
          ? detectJavaRootPackages(unkSourceDir)
          : [];
      const javaMethodsInclude = buildJavaMethodsInclude(
        detectedPkgsUnk,
        unkClassEntries.length > 0 ? unkClassEntries : undefined,
      );
      envList.push(
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${originalServiceName || name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
        'OTEL_EXPORTER_OTLP_PROTOCOL=grpc',
        `OTEL_INSTRUMENTATION_METHODS_INCLUDE=${javaMethodsInclude}`,
        'JAVA_TOOL_OPTIONS=-javaagent:/tmp/otel-agent.jar',
      );
      if (!svc.volumes) svc.volumes = [];
      const agentMount = `${OTEL_AGENT_HOST_PATH}:/tmp/otel-agent.jar:ro`;
      if (
        !svc.volumes.some((v: string) => String(v).includes('otel-agent.jar'))
      ) {
        svc.volumes.push(agentMount);
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

/**
 * Scans for Kubernetes manifest YAML files in known directories and extracts
 * per-service env vars (e.g. *_SERVICE_ADDR, PORT) that services need to
 * communicate with each other.
 *
 * These vars are missing from FRA-generated compose files (which only know
 * about OTel config), so services like checkoutservice crash because
 * SHIPPING_SERVICE_ADDR is not set.
 *
 * Returns Map<serviceName, Record<envKey, envValue>>.
 */
async function extractKubernetesServiceEnvVars(
  repoPath: string,
): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();

  const k8sDirs = [
    'kubernetes-manifests',
    'k8s',
    'k8s-manifests',
    'deploy/kubernetes',
    'deployment/kubernetes',
    'manifests',
  ];

  for (const dir of k8sDirs) {
    const dirPath = path.join(repoPath, dir);
    let entries: string[] = [];
    try {
      entries = (await fs.promises.readdir(dirPath)).filter(
        f => f.endsWith('.yaml') || f.endsWith('.yml'),
      );
    } catch {
      continue;
    }

    for (const file of entries) {
      const filePath = path.join(dirPath, file);
      let raw: string;
      try {
        raw = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      for (const doc of raw.split(/^---$/m)) {
        let parsed: any;
        try {
          parsed = yaml.parse(doc);
        } catch {
          continue;
        }
        if (!parsed || parsed.kind !== 'Deployment') continue;

        const svcName: string =
          parsed.metadata?.name ||
          parsed.spec?.selector?.matchLabels?.app ||
          '';
        if (!svcName) continue;

        const containers: any[] = parsed.spec?.template?.spec?.containers || [];
        const envMap: Record<string, string> = {};

        for (const container of containers) {
          for (const envEntry of container.env || []) {
            if (!envEntry.name || !envEntry.value) continue;
            const key: string = envEntry.name;
            const val: string = String(envEntry.value);
            if (key.startsWith('OTEL_') || key.startsWith('OPENCENSUS_'))
              continue;
            envMap[key] = val;
          }
        }

        if (Object.keys(envMap).length > 0) {
          const existing = result.get(svcName) || {};
          result.set(svcName, { ...existing, ...envMap });
        }
      }
    }
  }

  return result;
}

/**
 * Post-processes a docker-compose.otel.yml string to add inter-service env
 * vars extracted from Kubernetes manifests (e.g. SHIPPING_SERVICE_ADDR).
 *
 * Only adds vars that are NOT already in the service's environment list.
 * Does NOT overwrite OTEL_* vars.
 */
export async function patchComposeWithKubernetesEnv(
  composeContent: string,
  repoPath: string,
): Promise<string> {
  const k8sEnv = await extractKubernetesServiceEnvVars(repoPath);
  if (k8sEnv.size === 0) return composeContent;

  let compose: any;
  try {
    compose = yaml.parse(composeContent);
  } catch {
    return composeContent;
  }
  if (!compose?.services) return composeContent;

  for (const [svcName, svc] of Object.entries(compose.services)) {
    const k8s = k8sEnv.get(svcName as string);
    if (!k8s) continue;

    const envList: string[] = Array.isArray((svc as any).environment)
      ? [...(svc as any).environment]
      : [];

    const existingKeys = new Set(envList.map((e: string) => e.split('=')[0]));

    for (const [key, val] of Object.entries(k8s)) {
      if (!existingKeys.has(key)) {
        envList.push(`${key}=${val}`);
      }
    }

    (svc as any).environment = envList;
  }

  return yaml.stringify(compose, { lineWidth: 0 });
}
