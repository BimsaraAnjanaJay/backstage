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

/**
 * FunctionRegistryBuilder — static analysis across Java, Node.js, Python, .NET.
 *
 * Uses regex-based source scanning (no external AST dependencies) to extract
 * application-level function and method definitions from a service's source tree.
 *
 * The resulting registry is used by FunctionCallAnalyzer to cross-reference span
 * operation names against known app functions, dramatically reducing false positives
 * from framework or compiler-generated spans.
 *
 * Supported languages: java, nodejs, typescript, python, dotnet
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { RegistryFunction, ServiceFunctionRegistry } from '../../lib/types';
import { DiscoveredService } from '../discovery/ServiceDiscoveryEngine';

// ─── Files / directories to always skip ─────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.mypy_cache',
  'bin',
  'obj',
  '.vs',
  'migrations',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'fixtures',
  'mocks',
  '__mocks__',
]);

// ─── Framework base classes / known infra classes to skip ───────────────────
// When a Java class extends OR implements one of these, its methods are framework, not app code.
const JAVA_FRAMEWORK_BASES = new Set([
  'HttpServlet',
  'GenericServlet',
  'Filter',
  'HandlerInterceptor',
  'WebMvcConfigurerAdapter',
  'WebMvcConfigurer',
  'ApplicationRunner',
  'CommandLineRunner',
  'AbstractHealthIndicator',
  'HealthIndicator',
  // Bean lifecycle interfaces
  'BeanPostProcessor',
  'BeanFactoryPostProcessor',
  'InitializingBean',
  'DisposableBean',
  // Message handling
  'MessageListener',
]);

// ─── Python decorators that mark framework handlers (not app logic) ──────────
const PYTHON_FRAMEWORK_DECORATORS = new Set([
  'route',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'app.route',
  'app.get',
  'app.post',
  'app.put',
  'app.delete',
  'router.route',
  'router.get',
  'router.post',
  'before_request',
  'after_request',
  'teardown_request',
]);

// ─── Node.js/TS names that are always framework/config, never app logic ──────
const NODE_SKIP_NAMES = new Set([
  'app',
  'router',
  'middleware',
  'use',
  'listen',
  'configure',
  'module',
  'exports',
  'require',
  'import',
  'describe',
  'it',
  'test',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  // JS keywords that appear before ( but are not method names
  'super',
  'catch',
  'try',
  'throw',
  'typeof',
  'instanceof',
  'delete',
  'switch',
  // JS global built-ins — never application function names
  'Date',
  'Error',
  'Promise',
  'Map',
  'Set',
  'Array',
  'Object',
  'Math',
  'JSON',
  'console',
  'Buffer',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'Symbol',
  'RegExp',
  'Number',
  'String',
  'Boolean',
  'Function',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
]);

// ─── Common method names that are always framework boilerplate ───────────────
const COMMON_SKIP_METHOD_NAMES = new Set([
  'constructor',
  'toString',
  'hashCode',
  'equals',
  'clone',
  'finalize',
  'getClass',
  'notify',
  'notifyAll',
  'wait',
  '__init__',
  '__str__',
  '__repr__',
  '__eq__',
  '__hash__',
  'setUp',
  'tearDown',
  'setUpClass',
  'tearDownClass',
  // Java entry points and lifecycle — never business logic
  'main',
  'run',
  'afterPropertiesSet',
  'destroy',
  'postProcessBeforeInitialization',
  'postProcessAfterInitialization',
  'postProcessBeforeDestruction',
  // Akka actor framework
  'createReceive',
  'preStart',
  'postStop',
  'preRestart',
  'postRestart',
]);

/** Recursively collect all source files matching an extension list. */
async function collectSourceFiles(
  dir: string,
  extensions: string[],
  maxDepth = 8,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  let results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectSourceFiles(
        full,
        extensions,
        maxDepth,
        depth + 1,
      );
      results = results.concat(sub);
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Java ────────────────────────────────────────────────────────────────────
/**
 * Extracts public/protected methods from Java source files.
 * Skips test classes, inner classes, and methods inherited from known framework bases.
 */
async function extractJavaFunctions(
  serviceDir: string,
): Promise<RegistryFunction[]> {
  const files = await collectSourceFiles(serviceDir, ['.java']);
  const results: RegistryFunction[] = [];

  for (const file of files) {
    const rel = path.relative(serviceDir, file);
    // Skip test files
    if (rel.includes('Test') || rel.includes('test') || rel.includes('Spec'))
      continue;

    let src: string;
    try {
      src = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }

    // Skip @SpringBootApplication classes — they only contain main() and @Bean factory methods
    if (/@SpringBootApplication\b/.test(src)) continue;

    // Detect class name, base class, and implemented interfaces
    const classMatch = src.match(
      /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+?))?(?:\s*\{)/,
    );
    const className = classMatch?.[1] || path.basename(file, '.java');
    const baseClass = classMatch?.[2] || '';
    const implementedIfaces = (classMatch?.[3] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (JAVA_FRAMEWORK_BASES.has(baseClass)) continue;
    if (implementedIfaces.some(i => JAVA_FRAMEWORK_BASES.has(i))) continue;

    // Skip if this looks like a pure config/entity class (heuristic)
    if (
      /@Configuration\b/.test(src) &&
      !/@RestController\b/.test(src) &&
      !/@Service\b/.test(src)
    )
      continue;

    // Build set of @Bean-annotated method names to exclude (bean factories are infra, not logic)
    const beanMethodNames = new Set<string>();
    const beanRe =
      /@Bean\b[\s\S]{0,300}?(?:public|protected)\s+(?:static\s+)?(?:[\w<>\[\],\s]+?)\s+(\w+)\s*\(/gm;
    for (const bm of src.matchAll(beanRe)) {
      if (bm[1]) beanMethodNames.add(bm[1]);
    }

    // Extract public/protected non-static methods
    // Pattern: optional-annotations public/protected [static] returnType methodName(
    const methodRe =
      /(?:@\w+\s*(?:\([^)]*\)\s*)*)*\s*(?:public|protected)\s+(?:static\s+)?(?!class\b)(?:[\w<>\[\],\s]+?)\s+(\w+)\s*\(/gm;
    for (const match of src.matchAll(methodRe)) {
      const methodName = match[1];
      if (!methodName) continue;
      if (COMMON_SKIP_METHOD_NAMES.has(methodName)) continue;
      if (beanMethodNames.has(methodName)) continue;
      // Skip getters/setters
      if (/^(?:get|set|is)[A-Z]/.test(methodName)) continue;
      results.push({
        name: methodName,
        className,
        file: rel,
        language: 'java',
      });
    }
  }
  return results;
}

// ─── Node.js / TypeScript ────────────────────────────────────────────────────
/**
 * Extracts named functions and class methods from JS/TS source files.
 */
async function extractNodeFunctions(
  serviceDir: string,
  language: 'nodejs' | 'typescript',
): Promise<RegistryFunction[]> {
  const exts =
    language === 'typescript'
      ? ['.ts', '.tsx', '.js']
      : ['.js', '.mjs', '.cjs'];
  const files = await collectSourceFiles(serviceDir, exts);
  const results: RegistryFunction[] = [];

  for (const file of files) {
    const rel = path.relative(serviceDir, file);
    // Skip test / config files
    if (/\.(test|spec|config|setup)\.[tj]sx?$/.test(file)) continue;
    if (rel.includes('node_modules')) continue;

    let src: string;
    try {
      src = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }

    // Strip comments to avoid false matches
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    // Named function declarations: function myFunc(
    const funcDeclRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    for (const m of stripped.matchAll(funcDeclRe)) {
      const name = m[1];
      if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
        continue;
      results.push({ name, file: rel, language });
    }

    // Arrow functions assigned to const/let: const myFunc = (
    const arrowRe =
      /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>/g;
    for (const m of stripped.matchAll(arrowRe)) {
      const name = m[1];
      if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
        continue;
      results.push({ name, file: rel, language });
    }

    // CommonJS exported functions: exports.myFunc = ... or module.exports.myFunc = ...
    // Catches controller-style patterns: exports.getAllUsers = async (req, res) => {...}
    const exportsRe = /(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
    for (const m of stripped.matchAll(exportsRe)) {
      const name = m[1];
      if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
        continue;
      results.push({ name, file: rel, language });
    }

    // Object method shorthand inside module.exports = { ... }
    // Catches: module.exports = { async checkUserExists(userId) { ... } }
    if (/module\.exports\s*=\s*\{/.test(stripped)) {
      const objMethodRe =
        /^\s+(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/gm;
      for (const m of stripped.matchAll(objMethodRe)) {
        const name = m[1];
        if (
          [
            'if',
            'for',
            'while',
            'switch',
            'catch',
            'function',
            'class',
            'return',
          ].includes(name)
        )
          continue;
        if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
          continue;
        results.push({ name, file: rel, language });
      }
    }

    // Object property arrow functions: propName: async (...) => {
    // Catches patterns like: save: async (data) => { ... }
    const objPropArrowRe =
      /^\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>/gm;
    for (const m of stripped.matchAll(objPropArrowRe)) {
      const name = m[1];
      if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
        continue;
      results.push({ name, file: rel, language });
    }

    // Class methods: [optional async] methodName(
    const classMethodRe =
      /(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\((?:[^)]*)\)\s*\{/g;
    // TypeScript class method signatures — require at least one explicit keyword modifier
    // so bare function calls like pino(), Date(), super() are not captured.
    const tsMethodRe =
      /(?:(?:public|private|protected|async|static)\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

    // Detect if file has class definitions
    if (/\bclass\s+\w+/.test(stripped)) {
      for (const m of stripped.matchAll(classMethodRe)) {
        const name = m[1];
        if (
          [
            'if',
            'for',
            'while',
            'switch',
            'catch',
            'super',
            'try',
            'throw',
            'function',
            'class',
            'return',
            'new',
            'delete',
            'typeof',
            'instanceof',
          ].includes(name)
        )
          continue;
        if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
          continue;
        // Detect class name from context (rough heuristic)
        const classMatches = stripped.slice(0, m.index).match(/class\s+(\w+)/g);
        const className = classMatches
          ? classMatches[classMatches.length - 1].replace('class ', '')
          : undefined;
        results.push({ name, className, file: rel, language });
      }

      for (const m of stripped.matchAll(tsMethodRe)) {
        const name = m[1];
        if (
          [
            'constructor',
            'if',
            'for',
            'while',
            'switch',
            'catch',
            'super',
            'try',
            'throw',
            'function',
            'class',
            'import',
            'export',
            'return',
            'const',
            'let',
            'var',
            'new',
            'delete',
            'typeof',
            'instanceof',
            'async',
            'await',
            'static',
            'public',
            'private',
            'protected',
          ].includes(name)
        )
          continue;
        if (NODE_SKIP_NAMES.has(name) || COMMON_SKIP_METHOD_NAMES.has(name))
          continue;
        results.push({ name, file: rel, language });
      }
    }
  }

  // Deduplicate by name+file
  const seen = new Set<string>();
  return results.filter(f => {
    const k = `${f.file}::${f.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── Python ──────────────────────────────────────────────────────────────────
/**
 * Extracts function and method definitions from Python source files.
 */
async function extractPythonFunctions(
  serviceDir: string,
): Promise<RegistryFunction[]> {
  const files = await collectSourceFiles(serviceDir, ['.py']);
  const results: RegistryFunction[] = [];

  for (const file of files) {
    const rel = path.relative(serviceDir, file);
    if (
      rel.includes('test_') ||
      rel.includes('_test') ||
      rel.includes('conftest') ||
      rel.endsWith('_pb2.py') ||
      rel.endsWith('_pb2_grpc.py')
    )
      continue;

    let src: string;
    try {
      src = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }

    const lines = src.split('\n');
    let currentClass: string | undefined;
    let lastDecorator = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Track class context
      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        continue;
      }

      // Track decorators
      if (trimmed.startsWith('@')) {
        lastDecorator = trimmed.slice(1).split('(')[0].toLowerCase();
        continue;
      }

      // Function/method definition
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (defMatch) {
        const name = defMatch[1];
        // Skip private/dunder methods
        if (name.startsWith('__') || name.startsWith('_')) {
          lastDecorator = '';
          continue;
        }
        if (COMMON_SKIP_METHOD_NAMES.has(name)) {
          lastDecorator = '';
          continue;
        }
        // Skip known framework-decorator handlers (they're route bindings not logic)
        if (PYTHON_FRAMEWORK_DECORATORS.has(lastDecorator)) {
          lastDecorator = '';
          continue;
        }
        results.push({
          name,
          className: currentClass,
          file: rel,
          language: 'python',
        });
        lastDecorator = '';
        continue;
      }

      // Reset class context on dedent (rough heuristic: non-indented non-class line)
      if (
        trimmed &&
        !trimmed.startsWith('#') &&
        !line.startsWith(' ') &&
        !line.startsWith('\t')
      ) {
        if (
          !trimmed.startsWith('class ') &&
          !trimmed.startsWith('def ') &&
          !trimmed.startsWith('@')
        ) {
          currentClass = undefined;
        }
      }
    }
  }
  return results;
}

// ─── .NET / C# ───────────────────────────────────────────────────────────────
/**
 * Extracts public methods from C# source files.
 */
async function extractDotnetFunctions(
  serviceDir: string,
): Promise<RegistryFunction[]> {
  const files = await collectSourceFiles(serviceDir, ['.cs']);
  const results: RegistryFunction[] = [];

  for (const file of files) {
    const rel = path.relative(serviceDir, file);
    if (
      rel.toLowerCase().includes('test') ||
      rel.toLowerCase().includes('migration')
    )
      continue;
    if (
      rel.toLowerCase().includes('generated') ||
      rel.toLowerCase().includes('designer')
    )
      continue;

    let src: string;
    try {
      src = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }

    // Class name
    const classMatch = src.match(
      /(?:public|internal|private|protected|abstract|sealed|\s)+class\s+(\w+)/,
    );
    const className = classMatch?.[1];

    // Public/protected methods
    const methodRe =
      /(?:public|protected|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+)*(?!class\b)(?:[\w<>\[\],?.\s]+?)\s+(\w+)\s*\(/gm;
    for (const m of src.matchAll(methodRe)) {
      const name = m[1];
      if (!name || COMMON_SKIP_METHOD_NAMES.has(name)) continue;
      if (
        [
          'void',
          'string',
          'int',
          'bool',
          'Task',
          'IActionResult',
          'async',
          'static',
          'new',
        ].includes(name)
      )
        continue;
      // Skip getters/setters
      if (/^(?:Get|Set|Is|Has)[A-Z]/.test(name)) continue;
      results.push({ name, className, file: rel, language: 'dotnet' });
    }
  }
  return results;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Builds a function registry for a single service by statically scanning
 * its source code.
 */
export async function buildServiceRegistry(
  service: DiscoveredService,
  serviceDir: string,
): Promise<ServiceFunctionRegistry> {
  let functions: RegistryFunction[] = [];

  try {
    switch (service.language) {
      case 'java':
        functions = await extractJavaFunctions(serviceDir);
        break;
      case 'nodejs':
        functions = await extractNodeFunctions(serviceDir, 'nodejs');
        break;
      case 'typescript':
        functions = await extractNodeFunctions(serviceDir, 'typescript');
        break;
      case 'python':
        functions = await extractPythonFunctions(serviceDir);
        break;
      case 'dotnet':
        functions = await extractDotnetFunctions(serviceDir);
        break;
      default:
        // Go and Rust: no regex-based support yet; return empty registry
        break;
    }
  } catch {
    // Registry is best-effort; never throw
  }

  return {
    service: service.name,
    language: service.language,
    functions,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Scans a repo for benchmark-style function config files (functions.json) that
 * list virtual functions by name + host_service. These are data-driven functions
 * that cannot be found by static AST scanning (e.g. polyglot-fra-benchmark where
 * function names are path parameters to a generic controller, not static methods).
 *
 * Recognised format:
 *   { "functions": [{ "name": "...", "host_service": "...", ... }] }
 *
 * Returns a map of serviceName (lowercased) → Set<functionName>.
 */
async function extractBenchmarkFunctions(
  repoRoot: string,
): Promise<Map<string, RegistryFunction[]>> {
  const result = new Map<string, RegistryFunction[]>();

  const candidates = [
    'benchmark/functions.json',
    'functions.json',
    'config/functions.json',
    'data/functions.json',
  ];

  for (const rel of candidates) {
    const fullPath = path.join(repoRoot, rel);
    if (!(await fs.pathExists(fullPath))) continue;
    try {
      const raw = await fs.readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const funcs: any[] = Array.isArray(parsed)
        ? parsed
        : parsed?.functions || [];
      for (const fn of funcs) {
        const name: string = fn.name || fn.function_name;
        const svc: string = fn.host_service || fn.service || fn.serviceName;
        if (!name || !svc) continue;
        const svcKey = svc.toLowerCase();
        if (!result.has(svcKey)) result.set(svcKey, []);
        result.get(svcKey)!.push({
          name,
          file: rel,
          language: 'unknown',
        });
      }
      break; // use the first matching file
    } catch {
      // not valid JSON or wrong format — try next
    }
  }

  return result;
}

/**
 * Builds registries for all discovered services in parallel.
 *
 * Also scans for benchmark-style function config files (functions.json) and
 * merges any virtual functions listed there into the appropriate service registry.
 * This ensures data-driven functions (like those in polyglot-fra-benchmark)
 * appear in results even before traces are collected.
 */
export async function buildAllRegistries(
  services: DiscoveredService[],
  repoRoot: string,
): Promise<ServiceFunctionRegistry[]> {
  const [registries, benchmarkFns] = await Promise.all([
    Promise.all(
      services.map(svc =>
        buildServiceRegistry(svc, path.join(repoRoot, svc.path)),
      ),
    ),
    extractBenchmarkFunctions(repoRoot),
  ]);

  // Merge benchmark virtual functions into matching registries
  if (benchmarkFns.size > 0) {
    for (const reg of registries) {
      const extra = benchmarkFns.get(reg.service.toLowerCase());
      if (extra && extra.length > 0) {
        const existingNames = new Set(reg.functions.map(f => f.name));
        const toAdd = extra.filter(f => !existingNames.has(f.name));
        if (toAdd.length > 0) {
          reg.functions = [...reg.functions, ...toAdd];
        }
      }
    }
  }

  return registries;
}

/**
 * Returns the set of known application function names from a collection of
 * service registries, indexed by serviceName → Set<functionName>.
 * Used by FunctionCallAnalyzer to cross-reference span names.
 */
export function buildRegistryLookup(
  registries: ServiceFunctionRegistry[],
): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();
  for (const reg of registries) {
    const names = new Set(reg.functions.map(f => f.name.toLowerCase()));
    lookup.set(reg.service.toLowerCase(), names);
  }
  return lookup;
}
