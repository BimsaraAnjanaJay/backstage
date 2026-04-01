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

import { FunctionAnalysis } from './types';

export function analyzeFunctionCalls(rawTraces: any[]): FunctionAnalysis[] {
  const functionStats = new Map<string, any>();

  rawTraces.forEach(trace => {
    // Build a map of spanID -> serviceName to quickly find caller services
    const spanServiceMap = new Map<string, string>();

    if (!trace.spans || !Array.isArray(trace.spans)) return;

    trace.spans.forEach((span: any) => {
      const process = trace.processes?.[span.processID];
      if (process) {
        spanServiceMap.set(span.spanID, process.serviceName);
      }
    });

    trace.spans.forEach((span: any) => {
      const process = trace.processes?.[span.processID];
      if (!process) return;

      const serviceName = process.serviceName;
      let functionName = span.operationName;

      const lowerName = functionName.toLowerCase();
      const noisePatterns = [
        'health', 'metrics', 'express.middleware', 'middleware -', 'router -', 'corsmiddleware',
        'fs.', 'net.', 'dns.', 'dns.lookup', 'tcp.connect', 'connect',
        'readfilesync', 'readfile', 'realpathsync', 'statsync', 'lstatsync', 'access', 'expressinit', 'jsonparser',
        'query', 'tcp', 'dns', 'fs ', 'net ', 'vfs', 'close', 'open', 'read', 'write', 'stat',
        'request handler', 'anonymous', 'pg.', 'mongodb.', 'mongoose.', 'sequelize.', 'knex.'
      ];
      const isNoise = noisePatterns.some(pattern => lowerName === pattern || lowerName.includes(pattern));

      // Block generic internal HTTP calls, but allow HTTP route handlers (e.g. `GET /`, `POST /api`)
      const isGenericHttp = lowerName === 'http' || !!functionName.match(/^HTTP [A-Z]+$/);
      
      // Preserve spans that look like actual routes (e.g. "GET /...") or manual tracer spans (e.g. "auth-...")
      // or specific business logic functions mentioned by user (internalValidationStep, extractTokenHash)
      const isAppSpan = functionName.startsWith('GET ') || functionName.startsWith('POST ') || 
                        functionName.includes('-') || functionName.includes('Step') || 
                        functionName.includes('Hash') || functionName.includes('Token');

      if ((isNoise || isGenericHttp) && !isAppSpan) {
        return;
      }
      
      // One more check: if it's just a single lowercase word without special chars, it's likely noise (e.g. "index", "middleware")
      if (!isAppSpan && !functionName.includes(' ') && functionName === functionName.toLowerCase() && functionName.length < 15) {
        return;
      }
      console.log(`[Analysis] ✅ Accepting span: ${functionName} for service: ${serviceName}`);

      // Initialize stats for this function if we haven't seen it yet
      if (!functionStats.has(functionName)) {
        functionStats.set(functionName, {
          service: serviceName,
          internalCalls: 0,
          externalCalls: 0,
          internalLatencies: [],
          externalLatencies: [],
          callers: new Map<string, number>(),
        });
      }

      const stats = functionStats.get(functionName);
      const latencyMs = (span.duration || 0) / 1000;

      // Determine caller service
      let callerService = 'external (client)';
      if (span.references && span.references.length > 0) {
        // Find the parent span
        const parentRef = span.references.find(
          (ref: any) => ref.refType === 'CHILD_OF',
        );
        if (parentRef) {
          callerService =
            spanServiceMap.get(parentRef.spanID) || 'unknown';
        }
      }

      // Tally the calls
      if (callerService === serviceName) {
        stats.internalCalls++;
        stats.internalLatencies.push(latencyMs);
      } else {
        stats.externalCalls++;
        stats.externalLatencies.push(latencyMs);
        const callerCount = stats.callers.get(callerService) || 0;
        stats.callers.set(callerService, callerCount + 1);
      }
    });
  });

  // Convert the map to the expected FunctionAnalysis array
  const results: FunctionAnalysis[] = [];

  functionStats.forEach((stats, functionName) => {
    const totalCalls = stats.internalCalls + stats.externalCalls;
    if (totalCalls === 0) return;

    let dominantCaller = 'none';
    let dominantCount = 0;

    stats.callers.forEach((count: number, caller: string) => {
      if (count > dominantCount) {
        dominantCount = count;
        dominantCaller = caller;
      }
    });

    const dominantPercent =
      totalCalls > 0 ? dominantCount / totalCalls : 0;

    const avgInternalLatency =
      stats.internalLatencies.length > 0
        ? stats.internalLatencies.reduce((a: number, b: number) => a + b, 0) /
        stats.internalLatencies.length
        : 0;

    const avgExternalLatency =
      stats.externalLatencies.length > 0
        ? stats.externalLatencies.reduce((a: number, b: number) => a + b, 0) /
        stats.externalLatencies.length
        : 0;

    results.push({
      functionName,
      currentService: stats.service,
      internalCalls: stats.internalCalls,
      externalCalls: stats.externalCalls,
      dominantCaller,
      dominantPercent,
      avgInternalLatency,
      avgExternalLatency,
    });
  });

  return results;
}
