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

import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';

export interface DiscoveredService {
  name: string;
  language: string;
  path: string;
  port: number;
  hasDockerfile: boolean;
  dockerfileName: string;
  entrypoint?: string;
  fromCompose?: boolean;
}

export interface RelocationResult {
  functionName: string;
  currentService: string;
  suggestedService: string | null;
  internalCalls: number;
  externalCalls: number;
  dominantCaller: string;
  dominantPercent: number;
  predictedLatencyImprovement: number;
  recommendation: 'relocate' | 'keep' | 'review' | 'extract';
  confidence: number;
  cohesionDelta: number;
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  isSharedUtility: boolean;
  circularRisk: boolean;
  priorityScore: number;
  patternStability: number;
  staticCoverage: 'covered' | 'uncovered' | 'unknown';
  codeLocation?: {
    file: string;
    className?: string;
    lineStart?: number;
    displayPath: string;
  };
  coLocationGroup?: string[];
  coLocationAction?: 'move-together' | 'extract-shared';
  callerServices?: Record<string, number>;
}

export interface JobStatus {
  status: 'cloning' | 'detecting' | 'deploying' | 'tracing' | 'analyzing' | 'done' | 'error';
  progress: number;
  currentStep: string;
  logs: string[];
  error?: string;
  result?: {
    services: DiscoveredService[];
    results: RelocationResult[];
    repoName: string;
  };
}

export class FunctionAnalyticsClient {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('function-analytics');
  }

  async detectServices(repoUrl: string): Promise<{ repoName: string; services: DiscoveredService[] }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/fra/detect-services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Failed to detect services: ${response.status}`);
    }
    return response.json();
  }

  async startFullAnalysis(repoUrl: string, lookbackHours?: number, selectedServices?: string[]): Promise<{ jobId: string }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/fra/run-full-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, lookbackHours, selectedServices }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Failed to start analysis: ${response.status}`);
    }
    return response.json();
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/fra/job/${encodeURIComponent(jobId)}/status`);
    if (!response.ok) {
      throw new Error(`Job not found: ${response.status}`);
    }
    return response.json();
  }

  async getAnalysis(lookback: string, services?: string[]): Promise<RelocationResult[]> {
    const baseUrl = await this.getBaseUrl();
    const params = new URLSearchParams({ lookback });
    if (services && services.length > 0) {
      params.set('services', services.join(','));
    }
    const response = await this.fetchApi.fetch(`${baseUrl}/analyze?${params}`);
    if (!response.ok) {
      throw new Error(`Analysis failed: ${response.status}`);
    }
    return response.json();
  }
}
