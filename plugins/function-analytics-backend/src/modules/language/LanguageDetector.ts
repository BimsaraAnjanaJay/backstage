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

export type SupportedLanguage =
  | 'nodejs'
  | 'typescript'
  | 'python'
  | 'go'
  | 'java'
  | 'ruby'
  | 'rust'
  | 'dotnet'
  | 'unknown';

export interface LanguageResult {
  language: SupportedLanguage;
  /** Confidence score 0–1 indicating how certain the detection is */
  confidence: number;
}

/**
 * Multi-signal language detector.
 *
 * Detects 8 languages by build-file presence.
 * Priority order matters for ambiguous repos (e.g. a Java repo that also has
 * a package.json for frontend tooling will correctly resolve to java because
 * pom.xml/build.gradle are checked after package.json but the infra-service
 * filter in ServiceDiscoveryEngine keeps them separate).
 *
 * Languages supported:
 *   nodejs     — package.json
 *   python     — requirements.txt | setup.py | pyproject.toml | main.py
 *   go         — go.mod
 *   java       — pom.xml | build.gradle | build.gradle.kts
 *   ruby       — Gemfile
 *   rust       — Cargo.toml
 *   dotnet     — *.csproj | *.fsproj | *.vbproj
 *   typescript — package.json + tsconfig.json (promoted from nodejs)
 */
export async function detectLanguage(
  servicePath: string,
): Promise<SupportedLanguage | null> {
  // Node.js / TypeScript
  if (await fs.pathExists(path.join(servicePath, 'package.json'))) {
    // Promote to typescript if tsconfig.json is also present
    if (await fs.pathExists(path.join(servicePath, 'tsconfig.json'))) {
      return 'typescript';
    }
    return 'nodejs';
  }

  // Python
  if (
    (await fs.pathExists(path.join(servicePath, 'requirements.txt'))) ||
    (await fs.pathExists(path.join(servicePath, 'setup.py'))) ||
    (await fs.pathExists(path.join(servicePath, 'pyproject.toml'))) ||
    (await fs.pathExists(path.join(servicePath, 'main.py')))
  ) {
    return 'python';
  }

  // Go
  if (await fs.pathExists(path.join(servicePath, 'go.mod'))) {
    return 'go';
  }

  // Java (Maven or Gradle)
  if (
    (await fs.pathExists(path.join(servicePath, 'pom.xml'))) ||
    (await fs.pathExists(path.join(servicePath, 'build.gradle'))) ||
    (await fs.pathExists(path.join(servicePath, 'build.gradle.kts')))
  ) {
    return 'java';
  }

  // Ruby
  if (
    (await fs.pathExists(path.join(servicePath, 'Gemfile'))) ||
    (await fs.pathExists(path.join(servicePath, 'Gemfile.lock')))
  ) {
    return 'ruby';
  }

  // Rust
  if (await fs.pathExists(path.join(servicePath, 'Cargo.toml'))) {
    return 'rust';
  }

  // .NET (C#, F#, VB)
  const allFiles = await fs.readdir(servicePath).catch(() => [] as string[]);
  const projectFile = allFiles.find(
    f =>
      f.endsWith('.csproj') || f.endsWith('.fsproj') || f.endsWith('.vbproj'),
  );
  if (projectFile) {
    return 'dotnet';
  }

  return null;
}

/**
 * Resolves the primary entrypoint file/argument for a service given its
 * detected language.  Returns `undefined` when it cannot be determined —
 * callers should fall back to language-specific defaults.
 */
export async function detectEntrypoint(
  servicePath: string,
  language: SupportedLanguage | string,
): Promise<string | undefined> {
  try {
    switch (language) {
      // ── Node.js / TypeScript ────────────────────────────────────────────
      case 'nodejs':
      case 'typescript': {
        const pkgRaw = await fs.readFile(
          path.join(servicePath, 'package.json'),
          'utf-8',
        );
        const pkg = JSON.parse(pkgRaw);
        // Prefer scripts.start entrypoint file over pkg.main
        const startScript: string = pkg.scripts?.start || '';
        const nodeMatch = startScript.match(/node\s+([\w./]+\.(?:js|ts))/);
        if (nodeMatch) return nodeMatch[1];
        return pkg.main || 'index.js';
      }

      // ── Python ──────────────────────────────────────────────────────────
      case 'python': {
        for (const candidate of [
          'main.py',
          'app.py',
          'server.py',
          'run.py',
          'wsgi.py',
        ]) {
          if (await fs.pathExists(path.join(servicePath, candidate))) {
            return candidate;
          }
        }
        return 'main.py';
      }

      // ── Go ───────────────────────────────────────────────────────────────
      case 'go': {
        if (await fs.pathExists(path.join(servicePath, 'main.go'))) {
          return 'main.go';
        }
        // Some repos put main.go under cmd/<name>/
        const cmdDir = path.join(servicePath, 'cmd');
        if (await fs.pathExists(cmdDir)) {
          const subdirs = await fs.readdir(cmdDir);
          if (subdirs.length > 0) return `cmd/${subdirs[0]}/main.go`;
        }
        return 'main.go';
      }

      // ── Java ─────────────────────────────────────────────────────────────
      case 'java': {
        // Return jar search hint used by DockerComposeAdapter
        const targetDir = path.join(servicePath, 'target');
        if (await fs.pathExists(targetDir)) {
          const jars = (await fs.readdir(targetDir)).filter(
            f =>
              f.endsWith('.jar') &&
              !f.includes('sources') &&
              !f.includes('javadoc'),
          );
          if (jars.length > 0) return `target/${jars[0]}`;
        }
        return undefined; // DockerComposeAdapter will search at container start
      }

      // ── Ruby ─────────────────────────────────────────────────────────────
      case 'ruby': {
        for (const candidate of [
          'config.ru',
          'app.rb',
          'server.rb',
          'application.rb',
          'main.rb',
        ]) {
          if (await fs.pathExists(path.join(servicePath, candidate))) {
            return candidate;
          }
        }
        return 'app.rb';
      }

      // ── .NET ─────────────────────────────────────────────────────────────
      case 'dotnet': {
        const files = await fs.readdir(servicePath).catch(() => [] as string[]);
        const csproj = files.find(f => f.endsWith('.csproj'));
        // Return the project name (without extension) — used as `dotnet run --project`
        return csproj ? csproj.replace(/\.(cs|fs|vb)proj$/, '') : undefined;
      }

      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
