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
 * Map of outdated Docker base images to their modern replacements.
 * Extracted verbatim from router.ts `fixDockerfiles()`.
 */
const IMAGE_REPLACEMENTS: Record<string, string> = {
  // Node.js - upgrade old versions to LTS
  'node:6-alpine': 'node:20-alpine',
  'node:8-alpine': 'node:20-alpine',
  'node:10-alpine': 'node:20-alpine',
  'node:12-alpine': 'node:20-alpine',
  'node:14-alpine': 'node:20-alpine',
  'node:6': 'node:20-alpine',
  'node:8': 'node:20-alpine',
  'node:10': 'node:20-alpine',
  'node:12': 'node:20-alpine',
  'node:14': 'node:20-alpine',

  // Python - upgrade to supported versions
  'python:2.7-alpine': 'python:3.11-alpine',
  'python:3.6-alpine': 'python:3.11-alpine',
  'python:3.7-alpine': 'python:3.11-alpine',
  'python:2.7': 'python:3.11-alpine',
  'python:3.6': 'python:3.11-alpine',
  'python:3.7': 'python:3.11-alpine',

  // Java - replace deprecated OpenJDK with Eclipse Temurin JDK
  'openjdk:8-jre-alpine': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:8-alpine': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:11-alpine': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:8-jre': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:8': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:11': 'eclipse-temurin:17-jdk-alpine',

  // Go - upgrade to latest
  'golang:1.12-alpine': 'golang:1.21-alpine',
  'golang:1.14-alpine': 'golang:1.21-alpine',
  'golang:1.12': 'golang:1.21-alpine',
  'golang:1.14': 'golang:1.21-alpine',
};

/**
 * Walks all immediate subdirectories of repoPath and upgrades outdated
 * Dockerfile base images, adds npm update shims, and fixes mvnw permissions.
 *
 * Extracted verbatim from router.ts `fixDockerfiles()`.
 */
export async function fixDockerfiles(
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

    // Find the Dockerfile regardless of case (some repos use lowercase 'dockerfile')
    const dockerfileVariants = ['Dockerfile', 'dockerfile', 'DockerFile'];
    let dockerfilePath: string | null = null;
    for (const variant of dockerfileVariants) {
      const p = path.join(repoPath, entry.name, variant);
      if (await fs.pathExists(p)) {
        dockerfilePath = p;
        break;
      }
    }
    if (!dockerfilePath) continue;

    let content = await fs.readFile(dockerfilePath, 'utf-8');
    const originalContent = content;
    let modified = false;

    // --- Replace outdated base images ---
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim().toUpperCase().startsWith('FROM')) continue;
      for (const [oldImage, newImage] of Object.entries(IMAGE_REPLACEMENTS)) {
        const regex = new RegExp(
          `^(\\s*FROM\\s+)${oldImage.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}(\\s|$)`,
          'i',
        );
        if (regex.test(lines[i])) {
          lines[i] = lines[i].replace(regex, `$1${newImage}$2`);
          modified = true;
          logger.info(
            `Replaced ${oldImage} with ${newImage} in ${entry.name}/Dockerfile`,
          );
          break;
        }
      }
    }
    if (modified) content = lines.join('\n');

    // --- Add npm update shim for Node.js Dockerfiles ---
    if (
      content.includes('node:') &&
      content.includes('npm install') &&
      !content.includes('npm install -g npm')
    ) {
      const npmLines = content.split('\n');
      const fromIndex = npmLines.findIndex(
        l => l.trim().toUpperCase().startsWith('FROM') && l.includes('node:'),
      );
      if (fromIndex >= 0 && fromIndex < npmLines.length - 1) {
        const indent = npmLines[fromIndex].match(/^\s*/)?.[0] || '';
        npmLines.splice(
          fromIndex + 1,
          0,
          `${indent}RUN npm install -g npm@latest`,
        );
        content = npmLines.join('\n');
        modified = true;
        logger.info(`Added npm update to ${entry.name}/Dockerfile`);
      }
    }

    // --- Add OTEL packages for Node.js Dockerfiles (build-time install) ---
    // Install OTEL packages after the service's own `npm install` so they are
    // baked into the image. This avoids the slow/unreliable runtime npm install
    // that was previously done in the startup command.
    if (
      content.includes('node:') &&
      !content.includes('@opentelemetry/auto-instrumentations-node')
    ) {
      const otelLines = content.split('\n');
      // Find last `RUN npm install` line (the app's own install, not -g update)
      let lastNpmInstall = -1;
      for (let i = 0; i < otelLines.length; i++) {
        const trimmed = otelLines[i].trim();
        if (
          trimmed.startsWith('RUN') &&
          trimmed.includes('npm install') &&
          !trimmed.includes('-g') &&
          !trimmed.includes('@opentelemetry')
        ) {
          lastNpmInstall = i;
        }
      }
      if (lastNpmInstall >= 0) {
        const indent = otelLines[lastNpmInstall].match(/^\s*/)?.[0] || '';
        otelLines.splice(
          lastNpmInstall + 1,
          0,
          `${indent}RUN npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node`,
        );
        content = otelLines.join('\n');
        modified = true;
        logger.info(
          `Added OTEL build-time install to ${entry.name}/Dockerfile`,
        );
      }
    }

    // --- Fix mvnw permissions for Java services ---
    if (content.includes('openjdk') || content.includes('temurin')) {
      const javaLines = content.split('\n');
      let mvnwFixed = false;
      for (let i = 0; i < javaLines.length; i++) {
        if (!javaLines[i].includes('./mvnw') || mvnwFixed) continue;

        let copyIndex = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (
            javaLines[j].includes('COPY') &&
            (javaLines[j].includes('mvnw') || javaLines[j].includes('.mvn'))
          ) {
            copyIndex = j;
            break;
          }
        }

        if (copyIndex < 0) continue;

        let hasChmod = false;
        for (let k = copyIndex; k < i; k++) {
          if (
            (javaLines[k].includes('chmod') ||
              javaLines[k].includes('dos2unix') ||
              javaLines[k].includes('sed')) &&
            javaLines[k].includes('mvnw')
          ) {
            hasChmod = true;
            break;
          }
        }

        if (!hasChmod) {
          const indent = javaLines[copyIndex].match(/^\s*/)?.[0] || '';
          let insertIndex = copyIndex;
          while (
            insertIndex < javaLines.length - 1 &&
            javaLines[insertIndex + 1].includes('COPY')
          ) {
            insertIndex++;
          }
          javaLines.splice(
            insertIndex + 1,
            0,
            `${indent}RUN dos2unix mvnw 2>/dev/null || sed -i 's/\\r$//' mvnw || true`,
            `${indent}RUN chmod +x mvnw`,
          );
          modified = true;
          mvnwFixed = true;
          logger.info(
            `Added dos2unix and mvnw chmod to ${entry.name}/Dockerfile`,
          );
        }
      }
      content = javaLines.join('\n');
    }

    if (modified && content !== originalContent) {
      await fs.writeFile(dockerfilePath, content);
      logger.info(`Updated Dockerfile for service: ${entry.name}`);
    }
  }
}
