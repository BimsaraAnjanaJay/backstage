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
 * Resolves function names from gRPC operation name patterns.
 *
 * gRPC spans typically have operation names like "/package.Service/Method".
 * This resolver extracts the method name.
 *
 * Examples:
 *   "/helloworld.Greeter/SayHello" → "SayHello"
 *   "/grpc.health.v1.Health/Check" → "Check"
 *
 * Extracted from frontend utils.ts lines 79-82.
 * Priority: 5
 */
export class GrpcResolver implements FunctionNameResolver {
  readonly name = 'GrpcResolver';

  resolve(span: NormalizedSpan): string | undefined {
    const op = span.operationName?.trim();
    if (!op) return undefined;

    const grpcMatch = op.match(/^\/[A-Za-z0-9.]+\/([A-Za-z0-9_]+)/);
    if (grpcMatch) return grpcMatch[1];

    return undefined;
  }
}
