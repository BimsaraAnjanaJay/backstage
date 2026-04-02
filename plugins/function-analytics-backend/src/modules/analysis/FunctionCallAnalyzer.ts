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

import { FunctionAnalysis } from '../../lib/types';

/**
 * Noise patterns that identify infrastructure / framework spans which should
 * not be treated as business-logic functions.
 *
 * Moved from the inline array in lib/analysis.ts.
 * Phase 3 will make this list configurable via FraConfig.noiseFilter.
 */
const NOISE_PATTERNS = [
  'health',
  'metrics',
  'express.middleware',
  'middleware -',
  'router -',
  'corsmiddleware',
  'fs.',
  'net.',
  'dns.',
  'dns.lookup',
  'tcp.connect',
  'connect',
  'readfilesync',
  'readfile',
  'realpathsync',
  'statsync',
  'lstatsync',
  'access',
  'expressinit',
  'jsonparser',
  'query',
  'tcp',
  'dns',
  'fs ',
  'net ',
  'vfs',
  'close',
  'open',
  'read',
  'write',
  'stat',
  'request handler',
  'anonymous',
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
];

/**
 * Analyzes raw Jaeger traces and tallies per-function internal vs external
 * call counts, latencies, and dominant callers.
 *
 * Moved verbatim from lib/analysis.ts `analyzeFunctionCalls()`.
 */
export function analyzeFunctionCalls(rawTraces: any[]): FunctionAnalysis[] {
  const functionStats = new Map<string, any>();

  rawTraces.forEach(trace => {
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
      const functionName: string = span.operationName;

      const lowerName = functionName.toLowerCase();
      const isNoise = NOISE_PATTERNS.some(
        p => lowerName === p || lowerName.includes(p),
      );
      const isGenericHttp =
        lowerName === 'http' || !!functionName.match(/^HTTP [A-Z]+$/);
      const isAppSpan =
        functionName.startsWith('GET ') ||
        functionName.startsWith('POST ') ||
        functionName.includes('-') ||
        functionName.includes('Step') ||
        functionName.includes('Hash') ||
        functionName.includes('Token');

      if ((isNoise || isGenericHttp) && !isAppSpan) return;

      if (
        !isAppSpan &&
        !functionName.includes(' ') &&
        functionName === functionName.toLowerCase() &&
        functionName.length < 15
      ) {
        return;
      }

      console.log(
        `[Analysis] ✅ Accepting span: ${functionName} for service: ${serviceName}`,
      );

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

      let callerService = 'external (client)';
      if (span.references?.length > 0) {
        const parentRef = span.references.find(
          (ref: any) => ref.refType === 'CHILD_OF',
        );
        if (parentRef) {
          callerService = spanServiceMap.get(parentRef.spanID) || 'unknown';
        }
      }

      if (callerService === serviceName) {
        stats.internalCalls++;
        stats.internalLatencies.push(latencyMs);
      } else {
        stats.externalCalls++;
        stats.externalLatencies.push(latencyMs);
        stats.callers.set(
          callerService,
          (stats.callers.get(callerService) || 0) + 1,
        );
      }
    });
  });

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

    const dominantPercent = totalCalls > 0 ? dominantCount / totalCalls : 0;
    const avg = (arr: number[]) =>
      arr.length > 0
        ? arr.reduce((a: number, b: number) => a + b, 0) / arr.length
        : 0;

    results.push({
      functionName,
      currentService: stats.service,
      internalCalls: stats.internalCalls,
      externalCalls: stats.externalCalls,
      dominantCaller,
      dominantPercent,
      avgInternalLatency: avg(stats.internalLatencies),
      avgExternalLatency: avg(stats.externalLatencies),
    });
  });

  return results;
}
