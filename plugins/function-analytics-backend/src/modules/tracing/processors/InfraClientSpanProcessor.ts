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

import {
  SpanProcessor,
  NormalizedSpan,
  NormalizedTrace,
} from '../../../lib/providers';

/** FRA custom tag — if set, the span has an explicit app-level function name. */
const FRA_FUNCTION_NAME_TAG = 'fra.function_name';

/** URL patterns that identify infrastructure service client calls. */
const INFRA_URL_PATTERNS = [
  'eureka',
  'zipkin',
  ':9411',  // Zipkin default port
  ':8761',  // Eureka default port
];

/**
 * Filters out outgoing client HTTP spans to infrastructure endpoints.
 *
 * These represent calls *made by* the service to infrastructure (Eureka,
 * Zipkin, etc.), not functions *in* the service.
 *
 * Extracted from FunctionCallAnalyzer.ts lines 272-286 and
 * jaegerService.ts lines 78-89.
 */
export class InfraClientSpanProcessor implements SpanProcessor {
  readonly name = 'InfraClientSpanProcessor';

  process(
    span: NormalizedSpan,
    _trace: NormalizedTrace,
  ): NormalizedSpan | undefined {
    // Only filter client spans
    if (span.spanKind !== 'client' && span.tags['span.kind'] !== 'client') {
      return span;
    }

    // If FRA tag explicitly names the function, keep the span
    if (span.tags[FRA_FUNCTION_NAME_TAG]) return span;

    // Check if the HTTP URL points to an infrastructure service
    const httpUrl =
      span.tags['http.url'] || span.tags['url.full'] || '';

    const isInfraCall = INFRA_URL_PATTERNS.some(p => httpUrl.includes(p));
    return isInfraCall ? undefined : span;
  }
}
