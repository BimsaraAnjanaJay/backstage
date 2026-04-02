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
import { simpleGit } from 'simple-git';
import { LoggerService } from '@backstage/backend-plugin-api';
import { FraConfig } from '../config/FraConfig';

/**
 * Extracts a filesystem-safe repo name from a Git URL or path.
 * Extracted verbatim from router.ts `extractRepoName()`.
 */
export function extractRepoName(repoUrl: string): string {
  const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
  return match ? match[1] : 'microservice';
}

/**
 * Clones a repository if it does not yet exist locally; skips the clone and
 * reuses the existing directory otherwise.
 *
 * Returns the absolute path to the local repository.
 *
 * Extracted from the inline clone logic that was repeated across multiple
 * route handlers in router.ts.
 */
export async function ingestRepository(
  repoUrl: string,
  logger: LoggerService,
  config: FraConfig = new FraConfig(),
): Promise<string> {
  const repoName = extractRepoName(repoUrl);
  const repoPath = config.repoPath(repoName);

  await fs.ensureDir(path.dirname(repoPath));

  if (await fs.pathExists(repoPath)) {
    logger.info(
      `Repository already exists at ${repoPath}, using existing copy`,
    );
    return repoPath;
  }

  const git = simpleGit();
  logger.info(`Cloning repository ${repoUrl} to ${repoPath}`);
  await git.clone(repoUrl, repoPath);
  logger.info(`Repository cloned successfully to ${repoPath}`);
  return repoPath;
}
