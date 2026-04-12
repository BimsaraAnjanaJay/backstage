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
 * Extracts a clean function name from Jaeger operation names
 * Handles various microservice patterns (REST, gRPC, message queues, etc.)
 */
/** Returns the last non-numeric, non-UUID, non-empty path segment, or '' if none found. */
function lastMeaningfulSegment(urlPath: string): string {
  const parts = urlPath.split('/').filter(p => p && p !== 'api');
  // Walk from the end, skip path parameters: numerics, UUIDs, {var}, <var>, *
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i].split('?')[0]; // strip query string
    if (!seg || seg === '*') continue;
    if (/^\d+$/.test(seg)) continue; // numeric ID
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        seg,
      )
    )
      continue; // UUID
    if (/^\{.+\}$/.test(seg) || /^<.+>$/.test(seg)) continue; // {pathVar} or <pathVar>
    return seg;
  }
  return parts[parts.length - 1]?.split('?')[0] || '';
}

export const extractGeneralFunctionName = (
  operationName: string,
  spanTags: any[],
): string => {
  // ── HTTP method + path (REST endpoints) ─────────────────────────────────
  // Handle "GET /path", "POST /api/resource/id/sub", etc.
  // We use full path parsing (not regex groups) to correctly skip numeric IDs.
  const httpPathMatch = operationName.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s]*)/i,
  );
  if (httpPathMatch) {
    return lastMeaningfulSegment(httpPathMatch[2]) || operationName;
  }

  // ── Non-path HTTP spans: "GET service-name" style (cross-service calls) ─
  const httpServiceMatch = operationName.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+([A-Za-z][A-Za-z0-9._-]+)/i,
  );
  if (httpServiceMatch) {
    return httpServiceMatch[2];
  }

  // ── Java/OOP method calls ────────────────────────────────────────────────
  // "OwnerRepository.findAll", "SomeController.getOwner", "pkg.Class.method"
  const dotMethodMatch = operationName.match(
    /\.([A-Za-z][A-Za-z0-9_]+)(?:\(|$)/,
  );
  if (dotMethodMatch) {
    return dotMethodMatch[1];
  }
  const simpleDotMatch = operationName.match(
    /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/,
  );
  if (simpleDotMatch) {
    return simpleDotMatch[2];
  }

  // ── gRPC ─────────────────────────────────────────────────────────────────
  const grpcMatch = operationName.match(/^\/[A-Za-z0-9.]+\/([A-Za-z0-9]+)/);
  if (grpcMatch) {
    return grpcMatch[1];
  }

  // ── C++ style "Class::method" ─────────────────────────────────────────────
  const colonMatch = operationName.match(/^[A-Za-z0-9]+::([A-Za-z0-9]+)/);
  if (colonMatch) {
    return colonMatch[1];
  }

  // ── Named operations: "publish event_name", "handle OrderCreated" ────────
  const patterns = [
    /^(publish|consume|process|handle|on)\s+([A-Za-z0-9_]+)/i,
    /^([a-z_]+)_([a-z_]+)/,
  ];
  for (const pattern of patterns) {
    const match = operationName.match(pattern);
    if (match) return match[match.length - 1];
  }

  // ── tag-based function name ───────────────────────────────────────────────
  const functionTag = spanTags.find(
    tag =>
      tag.key === 'function.name' ||
      tag.key === 'code.function' ||
      tag.key === 'method.name' ||
      tag.key === 'handler.name' ||
      tag.key === 'endpoint.name' ||
      tag.key === 'operation.name',
  );
  if (functionTag) {
    return String(functionTag.value);
  }

  // ── Last-resort sanitization ──────────────────────────────────────────────
  return operationName
    .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '')
    .replace(/^[A-Za-z0-9]+\s+/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
};
