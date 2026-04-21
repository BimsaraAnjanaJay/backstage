import { UrlReaderService } from '@backstage/backend-plugin-api';
import { Logger } from 'winston';

type SourceFile = { path: string; content: string };
type RepoSource = { rootUrl: string; subPath: string };

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx',
  '.java', '.py', '.go', '.rb',
  '.c', '.cpp', '.cs',
]); 

const SKIP_PATH_PARTS = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.yarn',
  'vendor',
  '__pycache__',
  '.git',
]);

const MAX_FILE_BYTES = 256 * 1024;
const FILE_READ_CONCURRENCY = 12;
const repoCache = new Map<string, Promise<SourceFile[]>>();

function getFileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function shouldSkipPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (
    normalized.endsWith('.min.js') ||
    normalized.endsWith('.min.css') ||
    normalized.includes('.generated.') ||
    normalized.endsWith('.pb.go') ||
    normalized.endsWith('_pb2.py') ||
    normalized.endsWith('_pb2_grpc.py')
  ) {
    return true;
  }

  const parts = normalized.split('/');
  return parts.some(part => SKIP_PATH_PARTS.has(part));
}

function normalizeRepoUrl(repoUrl: string): RepoSource {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== 'github.com') {
      return { rootUrl: repoUrl, subPath: '' };
    }

    const parts = url.pathname.split('/').filter(Boolean);
    // owner/repo/tree/ref/optional/sub/path
    if (parts.length >= 4 && parts[2] === 'tree') {
      const owner = parts[0];
      const repo = parts[1];
      const ref = parts[3];
      const subPath = parts.slice(4).join('/');
      return {
        rootUrl: `${url.protocol}//${url.hostname}/${owner}/${repo}/tree/${ref}`,
        subPath,
      };
    }
  } catch {
    // Fall through to using the original URL.
  }

  return { rootUrl: repoUrl, subPath: '' };
}

function isUnderSubPath(path: string, subPath: string): boolean {
  if (!subPath) return true;
  return path === subPath || path.startsWith(`${subPath}/`);
}

function stripSubPath(path: string, subPath: string): string {
  if (!subPath) return path;
  if (path === subPath) return '';
  return path.startsWith(`${subPath}/`) ? path.slice(subPath.length + 1) : path;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R | undefined>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;

      const value = await fn(items[current], current);
      if (value !== undefined) {
        results.push(value);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

export async function fetchCodeFromRepo(
  repoUrl: string,
  reader: UrlReaderService,
  logger: Logger
): Promise<SourceFile[]> {
  const { rootUrl, subPath } = normalizeRepoUrl(repoUrl);
  const cached = repoCache.get(rootUrl);
  if (cached) {
    logger.info(`Using cached source tree for: ${rootUrl}`);
    const files = await cached;
    return files
      .filter(file => isUnderSubPath(file.path, subPath))
      .map(file => ({
        path: stripSubPath(file.path, subPath),
        content: file.content,
      }))
      .filter(file => file.path.length > 0);
  }

  const fetchPromise = (async () => {
    const startedAt = Date.now();
    logger.info(`Using UrlReaderService.readTree() for: ${rootUrl}`);

    const tree = await reader.readTree(rootUrl);
    const files = await tree.files();

    const candidateFiles = files.filter(file => {
      const path = file.path;
      return (
        CODE_EXTENSIONS.has(getFileExtension(path)) &&
        !shouldSkipPath(path)
      );
    });

    logger.info(
      `Repo tree ready for ${rootUrl}: ${files.length} total file(s), ` +
      `${candidateFiles.length} candidate code file(s)`,
    );

    const indexedResults = await mapWithConcurrency(
      candidateFiles,
      FILE_READ_CONCURRENCY,
      async (file, index) => {
        const buffer = await file.content();
        if (buffer.length > MAX_FILE_BYTES) {
          logger.info(
            `Skipping large file ${file.path} (${buffer.length} bytes)`,
          );
          return undefined;
        }

        return {
          index,
          path: file.path,
          content: buffer.toString('utf8'),
        };
      },
    );

    indexedResults.sort((a, b) => a.index - b.index);
    const results = indexedResults.map(({ path, content }) => ({ path, content }));

    logger.info(
      `Extracted ${results.length} code file(s) from ${rootUrl} in ` +
      `${Date.now() - startedAt}ms`,
    );

    return results;
  })();

  repoCache.set(rootUrl, fetchPromise);

  try {
    const files = await fetchPromise;
    return files
      .filter(file => isUnderSubPath(file.path, subPath))
      .map(file => ({
        path: stripSubPath(file.path, subPath),
        content: file.content,
      }))
      .filter(file => file.path.length > 0);
  } catch (error) {
    repoCache.delete(rootUrl);
    throw error;
  }
}
