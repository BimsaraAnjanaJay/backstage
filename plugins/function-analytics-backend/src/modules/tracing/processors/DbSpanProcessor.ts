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

/**
 * Regex matching operation names that look like SQL statements.
 * Extracted from FunctionCallAnalyzer.ts lines 266-269.
 */
const SQL_PATTERN =
  /^(INSERT|SELECT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE|CREATE|DROP|ALTER)[\s_]/i;

/**
 * Filters out database / storage-layer spans.
 *
 * These are storage operations, not application functions. Detected by:
 * - Presence of db.system, db.operation, or db.statement OTel tags
 * - Operation name that looks like a SQL statement
 *
 * Extracted from FunctionCallAnalyzer.ts lines 258-270 and
 * jaegerService.ts lines 55-66.
 */
export class DbSpanProcessor implements SpanProcessor {
  readonly name = 'DbSpanProcessor';

  process(
    span: NormalizedSpan,
    _trace: NormalizedTrace,
  ): NormalizedSpan | undefined {
    // Database semantic convention tags
    if (
      span.tags['db.system'] ||
      span.tags['db.operation'] ||
      span.tags['db.statement']
    ) {
      return undefined;
    }

    // Operation name looks like a SQL statement
    if (SQL_PATTERN.test(span.operationName)) {
      return undefined;
    }

    return span;
  }
}
