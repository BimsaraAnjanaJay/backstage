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

import { ServiceMetrics, FunctionCall, FunctionPlacementAnalysis } from './types';

/**
 * Analyzes microservice architecture to identify dependencies,
 * critical paths, and performance bottlenecks
 */
export const analyzeMicroserviceArchitecture = (services: ServiceMetrics[]): {
  serviceMap: Map<string, string[]>;
  dependencyGraph: Map<string, string[]>;
  criticalPaths: string[][];
  bottlenecks: string[];
} => {
  const serviceMap = new Map<string, string[]>();
  const dependencyGraph = new Map<string, string[]>();
  const criticalPaths: string[][] = [];
  const bottlenecks: string[] = [];

  services.forEach(service => {
    const dependencies = new Set<string>();
    service.functions.forEach(func => {
      func.dependencies.forEach(dep => dependencies.add(dep));
    });
    serviceMap.set(service.serviceName, Array.from(dependencies));
    dependencyGraph.set(service.serviceName, Array.from(dependencies));
  });

  services.forEach(service => {
    const highExternalServices = service.functions
      .filter(func => func.externalCalls > func.internalCalls)
      .map(func => func.serviceName);
    
    if (highExternalServices.length > 0) {
      criticalPaths.push([service.serviceName, ...highExternalServices]);
    }
  });

  services.forEach(service => {
    if (service.avgLatency > 1000 || service.errorRate > 5) {
      bottlenecks.push(service.serviceName);
    }
  });

  return { serviceMap, dependencyGraph, criticalPaths, bottlenecks };
};

/**
 * Analyzes function placement and identifies misplaced functions
 * that should be relocated to optimize cross-service communication
 */
export const analyzeFunctionPlacement = (functions: FunctionCall[]): FunctionPlacementAnalysis[] => {
  const EXTERNAL_CALL_THRESHOLD = 0.65;
  
  return functions.map(func => {
    const totalCalls = func.internalCalls + func.externalCalls;
    const externalCallPercentage = totalCalls > 0 ? func.externalCalls / totalCalls : 0;
    const internalCallPercentage = totalCalls > 0 ? func.internalCalls / totalCalls : 0;
    
    const shouldRelocate = externalCallPercentage > EXTERNAL_CALL_THRESHOLD;
    
    let relocateReason = '';
    let suggestedTargetService = '';
    let securityRisk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    
    if (shouldRelocate) {
      let maxExternalService = '';
      let maxExternalPercentage = 0;
      
      for (const [serviceName, callCount] of Object.entries(func.externalCallFrequency)) {
        const servicePercentage = totalCalls > 0 ? (callCount / totalCalls) * 100 : 0;
        if (servicePercentage > maxExternalPercentage) {
          maxExternalPercentage = servicePercentage;
          maxExternalService = serviceName;
        }
      }
      
      if (maxExternalPercentage > internalCallPercentage * 100) {
        suggestedTargetService = maxExternalService;
      } else {
        suggestedTargetService = func.externalCallTargets.length > 0 ? func.externalCallTargets[0] : '';
      }
      
      if (externalCallPercentage > 0.85) {
        securityRisk = 'HIGH';
        relocateReason = `${Math.round(externalCallPercentage * 100)}% external calls (${maxExternalService}: ${Math.round(maxExternalPercentage)}%). High cross-service latency risk.`;
      } else if (externalCallPercentage > 0.75) {
        securityRisk = 'MEDIUM';
        relocateReason = `${Math.round(externalCallPercentage * 100)}% external calls (${maxExternalService}: ${Math.round(maxExternalPercentage)}%). Consider relocating to ${suggestedTargetService}.`;
      } else {
        securityRisk = 'LOW';
        relocateReason = `${Math.round(externalCallPercentage * 100)}% external calls (${maxExternalService}: ${Math.round(maxExternalPercentage)}%). Minor optimization opportunity.`;
      }
    } else {
      relocateReason = `Normally-placed. ${Math.round(internalCallPercentage * 100)}% internal calls.`;
    }
    
    return {
      functionName: func.functionName,
      serviceName: func.serviceName,
      totalCalls: func.callCount,
      internalCallPercentage: internalCallPercentage * 100,
      externalCallPercentage: externalCallPercentage * 100,
      shouldRelocate,
      relocateReason,
      suggestedTargetService,
      securityRisk,
      latencyImpact: func.crossServiceCallLatency,
      crossServiceCallCount: func.externalCalls,
    };
  });
};
