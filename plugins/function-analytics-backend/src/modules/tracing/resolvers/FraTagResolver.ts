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
 * Resolves function names from the FRA custom span tag `fra.function_name`.
 *
 * This is the highest-priority resolver. Services instrumented with the FRA SDK
 * set this tag to the exact application-level function name, which is authoritative.
 *
 * Extracted from FunctionCallAnalyzer.ts lines 152-155.
 * Priority: 1 (first in chain)
 */
export class FraTagResolver implements FunctionNameResolver {
  readonly name = 'FraTagResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const fraName = span.tags['fra.function_name'];
    if (fraName && fraName !== 'unknown') return fraName;
    return undefined;
  }
}
