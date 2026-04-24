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

import { FunctionNameResolver, NormalizedSpan } from '../../../lib/providers';

/**
 * Returns the last non-numeric, non-UUID, non-template path segment.
 * Skips 'api' segments. Returns '' if no meaningful segment found.
 *
 * Extracted from frontend utils.ts lines 22-39 (more robust than backend version).
 */
function lastMeaningfulSegment(urlPath: string): string {
  const parts = urlPath.split('/').filter(p => p && p !== 'api');
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i].split('?')[0];
    if (!seg || /^\*+$/.test(seg)) continue;
    if (/^\d+$/.test(seg)) continue;
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        seg,
      )
    )
      continue;
    if (/^\{.+\}$/.test(seg) || /^<.+>$/.test(seg)) continue;
    return seg;
  }
  return parts[parts.length - 1]?.split('?')[0] || '';
}

/**
 * Resolves function names from HTTP "METHOD /path" operation names.
 *
 * Examples:
 *   "GET /owners/{id}/pets" → "pets"
 *   "POST /api/v2/orders"  → "orders"
 *   "DELETE /users/123"     → "users"
 *
 * Uses the frontend's more robust `lastMeaningfulSegment` which handles
 * UUIDs, {pathVar}, <pathVar>, and skips 'api' segments.
 *
 * Also handles "GET service-name" style cross-service call spans.
 *
 * Extracted from FunctionCallAnalyzer.ts lines 178-195 and
 * frontend utils.ts lines 22-53.
 * Priority: 4
 */
export class UrlPathResolver implements FunctionNameResolver {
  readonly name = 'UrlPathResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const op = span.operationName?.trim();
    if (!op) return undefined;

    // HTTP method + path (REST endpoints)
    const httpPathMatch = op.match(
      /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/[^\s]*)/i,
    );
    if (httpPathMatch) {
      const segment = lastMeaningfulSegment(httpPathMatch[1]);
      return segment || undefined;
    }

    // "GET service-name" style (cross-service client calls)
    const httpServiceMatch = op.match(
      /^(?:GET|POST|PUT|DELETE|PATCH)\s+([A-Za-z][A-Za-z0-9._-]+)/i,
    );
    if (httpServiceMatch) {
      return httpServiceMatch[1];
    }

    return undefined;
  }
}
