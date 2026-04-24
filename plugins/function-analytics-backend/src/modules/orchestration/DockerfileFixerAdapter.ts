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
 */
const IMAGE_REPLACEMENTS: Record<string, string> = {
  // Node.js — upgrade pre-20 images (npm@latest requires Node 20+)
  'node:6-alpine': 'node:20-alpine',
  'node:8-alpine': 'node:20-alpine',
  'node:10-alpine': 'node:20-alpine',
  'node:12-alpine': 'node:20-alpine',
  'node:14-alpine': 'node:20-alpine',
  'node:16-alpine': 'node:20-alpine',
  'node:18-alpine': 'node:20-alpine',
  'node:6': 'node:20-alpine',
  'node:8': 'node:20-alpine',
  'node:10': 'node:20-alpine',
  'node:12': 'node:20-alpine',
  'node:14': 'node:20-alpine',
  'node:16': 'node:20-alpine',
  'node:18': 'node:20-alpine',
  // Python
  'python:2.7-alpine': 'python:3.11-alpine',
  'python:3.6-alpine': 'python:3.11-alpine',
  'python:3.7-alpine': 'python:3.11-alpine',
  'python:2.7': 'python:3.11-alpine',
  'python:3.6': 'python:3.11-alpine',
  'python:3.7': 'python:3.11-alpine',
  // Java — legacy "java:" images (removed from Docker Hub in 2022)
  'java:8': 'eclipse-temurin:17-jdk-alpine',
  'java:8-jre': 'eclipse-temurin:17-jre-alpine',
  'java:8-jdk': 'eclipse-temurin:17-jdk-alpine',
  'java:11': 'eclipse-temurin:17-jdk-alpine',
  'java:11-jre': 'eclipse-temurin:17-jre-alpine',
  'java:17': 'eclipse-temurin:17-jdk-alpine',
  'java:17-jre': 'eclipse-temurin:17-jre-alpine',
  // openjdk images
  'openjdk:8-jre-alpine': 'eclipse-temurin:17-jre-alpine',
  'openjdk:8-alpine': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:11-alpine': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:8-jre': 'eclipse-temurin:17-jre-alpine',
  'openjdk:8': 'eclipse-temurin:17-jdk-alpine',
  'openjdk:11': 'eclipse-temurin:17-jdk-alpine',
  // Go
  'golang:1.12-alpine': 'golang:1.21-alpine',
  'golang:1.14-alpine': 'golang:1.21-alpine',
  'golang:1.12': 'golang:1.21-alpine',
  'golang:1.14': 'golang:1.21-alpine',
};

/** Known infra service/image names that should never get a Dockerfile generated. */
const INFRA_SKIP = new Set([
  'mongo',
  'redis',
  'postgres',
  'mysql',
  'mariadb',
  'rabbitmq',
  'kafka',
  'zookeeper',
  'jaeger',
  'zipkin',
  'prometheus',
  'grafana',
  'elasticsearch',
  'nginx',
  'traefik',
  'config',
  'discovery',
  'gateway',
  'admin',
]);

function isInfraService(name: string): boolean {
  const lower = name.toLowerCase();
  return Array.from(INFRA_SKIP).some(k => lower.includes(k));
}

/**
 * Auto-generates a minimal Dockerfile for services that don't have one.
 * Supports: Node.js, Python, Java (Maven), Go.
 * Returns the path to the generated file, or null if language is unrecognised.
 */
async function tryGenerateDockerfile(
  serviceDir: string,
  serviceName: string,
  logger: LoggerService,
): Promise<string | null> {
  if (isInfraService(serviceName)) return null;

  const isNode = await fs.pathExists(path.join(serviceDir, 'package.json'));
  const isPython =
    (await fs.pathExists(path.join(serviceDir, 'requirements.txt'))) ||
    (await fs.pathExists(path.join(serviceDir, 'pyproject.toml')));
  const isJava =
    (await fs.pathExists(path.join(serviceDir, 'pom.xml'))) ||
    (await fs.pathExists(path.join(serviceDir, 'build.gradle')));
  const isGo = await fs.pathExists(path.join(serviceDir, 'go.mod'));

  if (!isNode && !isPython && !isJava && !isGo) return null;

  const dockerfilePath = path.join(serviceDir, 'Dockerfile');
  let dockerfile = '';

  if (isNode) {
    let main = 'index.js';
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(serviceDir, 'package.json'), 'utf-8'),
      );
      const startScript: string = pkg.scripts?.start || '';
      const nodeMatch = startScript.match(/node\s+([\w./]+\.(?:js|ts))/);
      if (nodeMatch) main = nodeMatch[1];
      else if (pkg.main) main = String(pkg.main);
    } catch {
      /* default */
    }

    dockerfile = `${[
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm install',
      'RUN npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node',
      'COPY . .',
      'EXPOSE 3000',
      `CMD ["node", "${main}"]`,
    ].join('\n')}\n`;
  } else if (isPython) {
    const candidates = ['main.py', 'app.py', 'server.py', 'run.py'];
    let entrypoint = 'main.py';
    for (const c of candidates) {
      if (await fs.pathExists(path.join(serviceDir, c))) {
        entrypoint = c;
        break;
      }
    }
    dockerfile = `${[
      'FROM python:3.11-alpine',
      'WORKDIR /app',
      'COPY requirements*.txt ./',
      'RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true',
      'RUN pip install --no-cache-dir opentelemetry-distro opentelemetry-exporter-otlp',
      'RUN opentelemetry-bootstrap -a install 2>/dev/null || true',
      'COPY . .',
      'EXPOSE 5000',
      `CMD ["opentelemetry-instrument", "python", "${entrypoint}"]`,
    ].join('\n')}\n`;
  } else if (isJava) {
    const hasMvnw = await fs.pathExists(path.join(serviceDir, 'mvnw'));
    const buildCmd = hasMvnw
      ? './mvnw package -DskipTests --no-transfer-progress'
      : 'mvn package -DskipTests --no-transfer-progress';
    const lines = [
      'FROM eclipse-temurin:17-jdk-alpine AS build',
      'WORKDIR /app',
    ];
    if (hasMvnw) {
      lines.push('COPY .mvn/ .mvn/', 'COPY mvnw .', 'RUN chmod +x mvnw');
    }
    lines.push(
      'COPY pom.xml .',
      'COPY src ./src',
      `RUN ${buildCmd}`,
      '',
      'FROM eclipse-temurin:17-jre-alpine',
      'WORKDIR /app',
      'COPY --from=build /app/target/*.jar app.jar',
      'EXPOSE 8080',
      'ENTRYPOINT ["java", "-jar", "app.jar"]',
    );
    dockerfile = `${lines.join('\n')}\n`;
  } else if (isGo) {
    dockerfile = `${[
      'FROM golang:1.21-alpine AS build',
      'WORKDIR /app',
      'COPY go.mod go.sum ./',
      'RUN go mod download',
      'COPY . .',
      'RUN go build -o service ./...',
      '',
      'FROM alpine:latest',
      'WORKDIR /app',
      'COPY --from=build /app/service .',
      'EXPOSE 8080',
      'CMD ["./service"]',
    ].join('\n')}\n`;
  }

  await fs.writeFile(dockerfilePath, dockerfile);
  let lang = 'go';
  if (isNode) lang = 'node';
  else if (isPython) lang = 'python';
  else if (isJava) lang = 'java';
  logger.info(`Auto-generated Dockerfile for ${serviceName} (${lang})`);
  return dockerfilePath;
}

/**
 * Applies all Dockerfile fixes to a single service directory:
 *  - Upgrades outdated base images.
 *  - Adds npm update shim for Node.js.
 *  - Installs OTEL packages at build time for Node.js.
 *  - Fixes mvnw permissions for Java.
 *  - Auto-generates a Dockerfile when none exists.
 */
async function fixSingleServiceDir(
  serviceDir: string,
  serviceName: string,
  logger: LoggerService,
): Promise<void> {
  // Find existing Dockerfile (case-insensitive)
  const dockerfileVariants = [
    'Dockerfile',
    'dockerfile',
    'DockerFile',
    'Dockerfile.dev',
  ];
  let dockerfilePath: string | null = null;
  for (const variant of dockerfileVariants) {
    const p = path.join(serviceDir, variant);
    if (await fs.pathExists(p)) {
      dockerfilePath = p;
      break;
    }
  }

  // Auto-generate if missing
  if (!dockerfilePath) {
    dockerfilePath = await tryGenerateDockerfile(
      serviceDir,
      serviceName,
      logger,
    );
  }
  if (!dockerfilePath) return;

  let content: string;
  try {
    content = await fs.readFile(dockerfilePath, 'utf-8');
  } catch {
    return;
  }
  const originalContent = content;
  let modified = false;

  // ── Replace outdated base images ─────────────────────────────────────────
  {
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
            `Replaced ${oldImage} → ${newImage} in ${serviceName}/Dockerfile`,
          );
          break;
        }
      }
    }
    if (modified) content = lines.join('\n');
  }

  // ── Rewrite single-stage "copy pre-built JAR" Dockerfiles ──────────────────
  // Pattern: FROM java:* or openjdk:*-jre  +  ADD/COPY ./target/*.jar
  // with NO Maven/Gradle build stage.
  // These Dockerfiles expect the JAR to be built on the host before Docker runs.
  // In a fresh clone there is no ./target/ directory, so the build always fails.
  // Replace the entire Dockerfile with a proper multi-stage Maven build.
  {
    const hasJarCopy =
      /^(ADD|COPY)\s+\.?\/?(target\/[\w.*-]+\.jar|target\/\*\.jar)/im.test(
        content,
      );
    const hasBuildStage = /^FROM\s+maven:/im.test(content);
    const hasMvnBuild = /RUN\s+(mvn|\.\/mvnw|gradle|\.\/gradlew)\b/im.test(
      content,
    );

    if (hasJarCopy && !hasBuildStage && !hasMvnBuild) {
      const hasMvnw = await fs.pathExists(path.join(serviceDir, 'mvnw'));
      const hasPom = await fs.pathExists(path.join(serviceDir, 'pom.xml'));
      const hasGradle =
        (await fs.pathExists(path.join(serviceDir, 'build.gradle'))) ||
        (await fs.pathExists(path.join(serviceDir, 'build.gradle.kts')));

      if (hasPom || hasGradle) {
        let newDockerfile: string;
        if (hasPom) {
          const buildCmd = hasMvnw
            ? 'RUN chmod +x mvnw && ./mvnw package -DskipTests --no-transfer-progress'
            : 'RUN mvn package -DskipTests --no-transfer-progress';
          newDockerfile = `${[
            '# Rewritten by FRA: original used a pre-built JAR; replaced with multi-stage Maven build',
            'FROM maven:3.9-eclipse-temurin-17 AS build',
            'WORKDIR /app',
            hasMvnw ? 'COPY .mvn/ .mvn/\nCOPY mvnw .' : '',
            'COPY pom.xml .',
            'COPY src ./src',
            buildCmd,
            '',
            'FROM eclipse-temurin:17-jre-alpine',
            'WORKDIR /app',
            'COPY --from=build /app/target/*.jar app.jar',
            'EXPOSE 8080',
            'ENTRYPOINT ["java", "-jar", "app.jar"]',
          ]
            .filter(l => l !== '')
            .join('\n')}\n`;
        } else {
          // Gradle
          const buildCmd = (await fs.pathExists(
            path.join(serviceDir, 'gradlew'),
          ))
            ? 'RUN chmod +x gradlew && ./gradlew build -x test --no-daemon'
            : 'RUN gradle build -x test --no-daemon';
          newDockerfile = `${[
            '# Rewritten by FRA: original used a pre-built JAR; replaced with multi-stage Gradle build',
            'FROM eclipse-temurin:17-jdk-alpine AS build',
            'WORKDIR /app',
            'COPY . .',
            buildCmd,
            '',
            'FROM eclipse-temurin:17-jre-alpine',
            'WORKDIR /app',
            'COPY --from=build /app/build/libs/*.jar app.jar',
            'EXPOSE 8080',
            'ENTRYPOINT ["java", "-jar", "app.jar"]',
          ].join('\n')}\n`;
        }
        content = newDockerfile;
        modified = true;
        logger.info(
          `Rewrote pre-built-JAR Dockerfile for ${serviceName} → multi-stage ${
            hasPom ? 'Maven' : 'Gradle'
          } build`,
        );
      }
    }
  }

  // ── Multi-module Maven: install parent POM before building ─────────────────
  // When a child pom.xml has <parent><relativePath>../</relativePath></parent>,
  // Maven needs the parent POM file to resolve properties and inherited deps.
  // Docker can't access ../pom.xml from the service-directory build context.
  // Fix: copy the parent pom.xml into the service dir as fra-parent-pom.xml,
  // then install it into the local Maven cache at the start of the Docker build.
  {
    const childPomPath = path.join(serviceDir, 'pom.xml');
    const parentPomPath = path.join(path.dirname(serviceDir), 'pom.xml');
    const hasPom = await fs.pathExists(childPomPath);
    const parentPomExists = hasPom && (await fs.pathExists(parentPomPath));

    if (parentPomExists) {
      let childPomContent = '';
      try {
        childPomContent = await fs.readFile(childPomPath, 'utf-8');
      } catch {
        /* ignore */
      }

      // Only proceed when the child explicitly references parent at ../
      const needsParent =
        childPomContent.includes('<parent>') &&
        /<relativePath>\s*\.\.\/?\s*<\/relativePath>/.test(childPomContent);

      if (
        needsParent &&
        content.includes('FROM maven:') &&
        !content.includes('fra-parent-pom.xml')
      ) {
        // Pre-stage parent POM in the service directory so Docker COPY can reach it.
        // Strip unavailable BUILD-SNAPSHOT dependencies (private artifacts not on Maven
        // Central) so the Docker build doesn't fail on unresolvable artifacts.
        let parentContent = await fs.readFile(parentPomPath, 'utf-8');
        // Remove actual (non-commented) dependency blocks with BUILD-SNAPSHOT versions.
        // The pattern anchors on <groupId> immediately following <dependency> to
        // avoid matching commented-out blocks like <!--<dependency>-->.
        parentContent = parentContent.replace(
          /[ \t]*<dependency>\s*\n\s*<groupId>[^<]*<\/groupId>\s*\n\s*<artifactId>[^<]*<\/artifactId>\s*\n\s*<version>[^<]*BUILD-SNAPSHOT[^<]*<\/version>\s*\n\s*<\/dependency>/g,
          '',
        );
        await fs.writeFile(
          path.join(serviceDir, 'fra-parent-pom.xml'),
          parentContent,
        );

        const hasMvnw = await fs.pathExists(path.join(serviceDir, 'mvnw'));
        const buildCmd = hasMvnw
          ? './mvnw package -DskipTests --no-transfer-progress'
          : 'mvn package -DskipTests --no-transfer-progress';
        const mvnwLines = hasMvnw
          ? ['COPY .mvn/ .mvn/', 'COPY mvnw .', 'RUN chmod +x mvnw']
          : [];

        content = `${[
          '# Rewritten by FRA: multi-module Maven — parent POM pre-staged for Docker build',
          'FROM maven:3.9-eclipse-temurin-17 AS build',
          'WORKDIR /app',
          '# Install parent POM into local Maven repo so child module can resolve <parent>',
          'COPY fra-parent-pom.xml parent-pom.xml',
          'RUN mvn install -N -q --no-transfer-progress -f parent-pom.xml',
          ...mvnwLines,
          'COPY pom.xml .',
          'COPY src ./src',
          `RUN ${buildCmd}`,
          '',
          'FROM eclipse-temurin:17-jre-alpine',
          'WORKDIR /app',
          'COPY --from=build /app/target/*.jar app.jar',
          'EXPOSE 8080',
          'ENTRYPOINT ["java", "-jar", "app.jar"]',
        ].join('\n')}\n`;

        modified = true;
        logger.info(
          `Added parent POM install step to ${serviceName}/Dockerfile`,
        );
      }
    }
  }

  // ── Remove "npm install -g npm@latest" if present (breaks on Node < 20) ──
  // npm@latest (v11+) requires Node >=20.17.0. Since we now always use node:20-alpine
  // this line is harmless but unnecessary; remove it to keep Dockerfiles clean.
  if (
    content.includes('npm install -g npm@latest') ||
    content.includes('npm install -g npm@')
  ) {
    const filtered = content
      .split('\n')
      .filter(l => !l.trim().match(/^RUN\s+npm\s+install\s+-g\s+npm@/))
      .join('\n');
    if (filtered !== content) {
      content = filtered;
      modified = true;
      logger.info(
        `Removed "npm install -g npm@latest" from ${serviceName}/Dockerfile`,
      );
    }
  }

  // ── OTEL packages at build time (Node.js) ────────────────────────────────
  if (
    content.includes('node:') &&
    !content.includes('@opentelemetry/auto-instrumentations-node')
  ) {
    const otelLines = content.split('\n');
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
      logger.info(`Added OTEL build-time install to ${serviceName}/Dockerfile`);
    }
  }

  // ── mvnw permissions for Java ─────────────────────────────────────────────
  if (
    content.includes('openjdk') ||
    content.includes('temurin') ||
    content.includes('amazoncorretto')
  ) {
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
        logger.info(`Fixed mvnw permissions in ${serviceName}/Dockerfile`);
      }
    }
    content = javaLines.join('\n');
  }

  if (modified && content !== originalContent) {
    await fs.writeFile(dockerfilePath, content);
    logger.info(`Updated Dockerfile: ${serviceName}`);
  }
}

/**
 * Walks depth-1 AND depth-2 subdirectories of repoPath.
 * Applies Dockerfile upgrades and auto-generates missing Dockerfiles.
 * Depth-2 only applies to Maven/Gradle multi-module parent directories.
 */
export async function fixDockerfiles(
  repoPath: string,
  logger: LoggerService,
): Promise<void> {
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = await fs.readdir(repoPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const serviceDir = path.join(repoPath, entry.name);

    // Depth-1 fix
    await fixSingleServiceDir(serviceDir, entry.name, logger);

    // Depth-2: only for Maven/Gradle multi-module parent dirs
    const isMultiModule =
      (await fs.pathExists(path.join(serviceDir, 'pom.xml'))) ||
      (await fs.pathExists(path.join(serviceDir, 'settings.gradle'))) ||
      (await fs.pathExists(path.join(serviceDir, 'settings.gradle.kts')));

    if (!isMultiModule) continue;

    let subEntries: fs.Dirent[] = [];
    try {
      subEntries = await fs.readdir(serviceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sub of subEntries) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
      const subDir = path.join(serviceDir, sub.name);
      const isModule =
        (await fs.pathExists(path.join(subDir, 'pom.xml'))) ||
        (await fs.pathExists(path.join(subDir, 'src')));
      if (isModule) {
        await fixSingleServiceDir(subDir, `${entry.name}/${sub.name}`, logger);
      }
    }
  }
}
