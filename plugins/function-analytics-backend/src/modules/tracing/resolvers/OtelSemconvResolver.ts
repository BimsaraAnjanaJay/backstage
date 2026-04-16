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
 * OTel semantic convention and common framework tags checked in priority order.
 * Merged from FunctionCallAnalyzer.ts SEMCONV_FUNCTION_TAGS and
 * frontend utils.ts lines 101-109.
 */
const FUNCTION_NAME_TAGS = [
  'code.function',
  'function.name',
  'method.name',
  'rpc.method',
  'handler.name',
  'endpoint.name',
  'operation.name',
];

/**
 * Resolves function names from OpenTelemetry semantic convention tags
 * and common framework tags.
 *
 * When `code.function` is set together with `code.namespace` (the JVM and
 * .NET auto-instrumentation populate both), the resolver returns
 * `Class.method` instead of just `method`, which keeps function identities
 * unique across services that happen to share method names like `find` or
 * `update`.
 *
 * Priority: 2
 */
export class OtelSemconvResolver implements FunctionNameResolver {
  readonly name = 'OtelSemconvResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const codeFn = span.tags['code.function'];
    if (codeFn && codeFn !== 'unknown') {
      const ns = span.tags['code.namespace'];
      if (ns) {
        const cls = ns.split('.').filter(Boolean).pop();
        if (cls) return `${cls}.${codeFn}`;
      }
      return codeFn;
    }

    for (const key of FUNCTION_NAME_TAGS) {
      const v = span.tags[key];
      if (v && v !== 'unknown') return v;
    }
    return undefined;
  }
}
