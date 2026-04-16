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

const ROUTE_TAGS = ['http.route', 'url.template'];
const PATH_TAGS = ['http.target', 'url.path', 'http.path'];
const METHOD_TAGS = ['http.method', 'http.request.method'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves function names from OpenTelemetry HTTP semantic convention tags.
 *
 * Real-world auto-instrumentation (Spring Boot, Express, ASP.NET, Flask, etc.)
 * sets `http.route` to the templated path matched by the framework router,
 * which is the most reliable signal for "which endpoint did this span handle".
 *
 * Output format: `METHOD /resource/{}/subresource` so that:
 *  - different HTTP methods produce different function identities
 *  - templated path variables and concrete IDs collapse to `{}`
 *  - `/api`, `/v1`, `/v2` prefixes are stripped
 *
 * Examples:
 *   http.route=/api/v1/owners/{id}/pets, http.method=GET → "GET /owners/{}/pets"
 *   http.target=/users/42,                http.method=DELETE → "DELETE /users/{}"
 *
 * Priority: 3 — runs after FraTagResolver and OtelSemconvResolver
 *               but before ClassMethodResolver and UrlPathResolver
 *               (those parse operationName heuristically; this reads explicit tags).
 */
export class HttpRouteResolver implements FunctionNameResolver {
  readonly name = 'HttpRouteResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const method = this.firstTag(span, METHOD_TAGS);

    // Prefer http.route (already templated by framework)
    for (const key of ROUTE_TAGS) {
      const v = span.tags[key];
      if (v) {
        const fn = this.toFunctionName(v, method);
        if (fn) return fn;
      }
    }

    // Fall back to raw path tags (template variables get inferred)
    for (const key of PATH_TAGS) {
      const v = span.tags[key];
      if (v) {
        const fn = this.toFunctionName(v, method);
        if (fn) return fn;
      }
    }

    return undefined;
  }

  private firstTag(span: NormalizedSpan, keys: string[]): string {
    for (const k of keys) {
      const v = span.tags[k];
      if (v) return v;
    }
    return '';
  }

  private toFunctionName(route: string, method: string): string | undefined {
    let path = route.split('?')[0].split('#')[0].trim();
    if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1);
    if (!path || path === '/') return undefined;

    const rawSegments = path.split('/').filter(Boolean);
    const segments = rawSegments.map(seg => this.normaliseSegment(seg));

    // Strip leading api / v1 / v2 prefixes
    let start = 0;
    while (
      start < segments.length &&
      (segments[start] === 'api' || /^v\d+$/i.test(segments[start]))
    ) {
      start++;
    }
    const cleanSegs = segments.slice(start);
    if (cleanSegs.length === 0) return undefined;

    const m = method.toUpperCase();
    const resource = cleanSegs.join('/');
    if (
      m &&
      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(m)
    ) {
      return `${m} /${resource}`;
    }
    return `/${resource}`;
  }

  private normaliseSegment(seg: string): string {
    // Templated parameter forms used by various frameworks
    if (/^\{.+\}$/.test(seg)) return '{}';
    if (/^:[A-Za-z_].*/.test(seg)) return '{}';
    if (/^\[.+\]$/.test(seg)) return '{}';
    if (/^<.+>$/.test(seg)) return '{}';
    // Concrete ID-like values
    if (/^\d+$/.test(seg)) return '{}';
    if (UUID_RE.test(seg)) return '{}';
    return seg;
  }
}
