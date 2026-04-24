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
  RelocationResult,
  ServiceFunctionRegistry,
  RegistryFunction,
} from '../../lib/types';

interface CodeLocation {
  file: string;
  className?: string;
  lineStart?: number;
  displayPath: string;
}

/**
 * Maps function names in RelocationResults to source code locations
 * using the static function registries built by FunctionRegistryBuilder.
 *
 * Matching strategy (in priority order):
 * 1. Exact match: functionName === registryFunction.name
 * 2. Class.method match: "ClassName.methodName" → className=ClassName, name=methodName
 * 3. Suffix match: functionName ends with registryFunction.name (handles package prefixes)
 * 4. Case-insensitive match
 */
export function enrichWithCodeLocations(
  results: RelocationResult[],
  registries: ServiceFunctionRegistry[],
): RelocationResult[] {
  // Build lookup: serviceName → RegistryFunction[]
  const registryByService = new Map<string, RegistryFunction[]>();
  for (const registry of registries) {
    registryByService.set(registry.service, registry.functions);
  }

  return results.map(result => {
    const codeLocation = resolveCodeLocation(
      result.functionName,
      result.currentService,
      registryByService,
    );
    if (codeLocation) {
      return { ...result, codeLocation };
    }
    return result;
  });
}

function resolveCodeLocation(
  functionName: string,
  serviceName: string,
  registryByService: Map<string, RegistryFunction[]>,
): CodeLocation | undefined {
  // Try exact service first, then all services
  const serviceNames = [
    serviceName,
    ...Array.from(registryByService.keys()).filter(s => s !== serviceName),
  ];

  for (const svcName of serviceNames) {
    const functions = registryByService.get(svcName);
    if (!functions) continue;

    // 1. Exact match
    const exact = functions.find(f => f.name === functionName);
    if (exact) return toCodeLocation(exact);

    // 2. Class.method match: "UserController.getUser" → className=UserController, name=getUser
    const dotIdx = functionName.lastIndexOf('.');
    if (dotIdx > 0) {
      const className = functionName.substring(0, dotIdx);
      const methodName = functionName.substring(dotIdx + 1);
      const classMethod = functions.find(
        f => f.name === methodName && f.className === className,
      );
      if (classMethod) return toCodeLocation(classMethod);

      // Also try just the method name
      const methodOnly = functions.find(f => f.name === methodName);
      if (methodOnly) return toCodeLocation(methodOnly);
    }

    // 3. Suffix match: "com.example.UserService.process" → find "process"
    const parts = functionName.split('.');
    const lastName = parts[parts.length - 1];
    if (lastName !== functionName) {
      const suffix = functions.find(f => f.name === lastName);
      if (suffix) return toCodeLocation(suffix);
    }

    // 4. Case-insensitive match
    const lowerName = functionName.toLowerCase();
    const caseInsensitive = functions.find(
      f => f.name.toLowerCase() === lowerName,
    );
    if (caseInsensitive) return toCodeLocation(caseInsensitive);

    // 5. Service-prefix strip: some static registries store functions as
    //    "{service}-{functionName}" (e.g. "auth-extractTokenHash") while the
    //    trace reports only "extractTokenHash". Strip the "{service}-" prefix
    //    from registry candidates and retry matching.
    const servicePrefix = `${svcName}-`;
    for (const fn of functions) {
      if (!fn.name.startsWith(servicePrefix)) continue;
      const stripped = fn.name.slice(servicePrefix.length);
      if (
        stripped === functionName ||
        stripped.toLowerCase() === lowerName ||
        stripped.startsWith(`${functionName}-`)
      ) {
        return toCodeLocation(fn);
      }
    }
  }

  return undefined;
}

function toCodeLocation(fn: RegistryFunction): CodeLocation {
  return {
    file: fn.file,
    className: fn.className,
    lineStart: undefined, // Line numbers not tracked in current registry
    displayPath: fn.className
      ? `${fn.file} (${fn.className}.${fn.name})`
      : `${fn.file}:${fn.name}`,
  };
}
