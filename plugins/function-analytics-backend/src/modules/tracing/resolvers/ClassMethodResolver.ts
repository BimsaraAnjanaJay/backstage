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
 * Resolves function names from "Class.method" or "Class::method" patterns
 * in the operation name.
 *
 * Handles:
 * - "OwnerController.findOwner" → "OwnerController.findOwner" (keep qualified)
 * - "auth.validateToken" → "auth.validateToken" (keep qualified)
 * - "pkg.Class.method()" → "method" (extract last method)
 * - "Class::method" → "method" (C++ style)
 *
 * Extracted from FunctionCallAnalyzer.ts lines 166-176 and
 * frontend utils.ts lines 63-88.
 * Priority: 3
 */
export class ClassMethodResolver implements FunctionNameResolver {
  readonly name = 'ClassMethodResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const op = span.operationName?.trim();
    if (!op) return undefined;

    // "Controller.method" or "Service.method" — well-known Java/OOP patterns
    const dottedClassMatch = op.match(
      /^([A-Za-z0-9]+(?:Controller|Service|Repository|Handler|Manager))\.([A-Za-z0-9_]+)/,
    );
    if (dottedClassMatch) return `${dottedClassMatch[1]}.${dottedClassMatch[2]}`;

    // "word.word" — simple dotted notation (e.g. "auth.validateToken")
    const simpleDotted = op.match(
      /^([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)$/,
    );
    if (simpleDotted) return op;

    // "pkg.Class.method()" — deeper dotted chain with parens
    const deepDotMatch = op.match(/\.([A-Za-z][A-Za-z0-9_]+)(?:\(|$)/);
    if (deepDotMatch) return deepDotMatch[1];

    // "Class::method" — C++ style
    const colonMatch = op.match(/^[A-Za-z0-9]+::([A-Za-z0-9]+)/);
    if (colonMatch) return colonMatch[1];

    return undefined;
  }
}
