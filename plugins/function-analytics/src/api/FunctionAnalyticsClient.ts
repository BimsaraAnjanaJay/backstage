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
  status:
    | 'cloning'
    | 'detecting'
    | 'deploying'
    | 'tracing'
    | 'analyzing'
    | 'done'
    | 'error';
  progress: number;
  currentStep: string;
  logs: string[];
  error?: string;
  result?: {
    services: DiscoveredService[];
    results: RelocationResult[];
    repoName: string;
    /** False when synthetic traces were used (no live Jaeger data available). */
    tracingAvailable: boolean;
    /** True when results are derived from synthetic traces instead of real traces. */
    syntheticTraces?: boolean;
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

  async detectServices(
    repoUrl: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ repoName: string; services: DiscoveredService[] }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/fra/detect-services`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      },
    );
    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(
        err.error || `Failed to detect services: ${response.status}`,
      );
    }

    const data = await response.json();

    // Fast path: repo was already cloned — result is inline
    if (!data.cloning) {
      return { repoName: data.repoName, services: data.services };
    }

    // Slow path: repo is being cloned in the background — poll for completion
    const { jobId, repoName } = data;
    onProgress?.(`Cloning repository (this may take a minute)…`);

    const POLL_INTERVAL_MS = 3000;
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await this.fetchApi.fetch(
        `${baseUrl}/fra/detect-job/${encodeURIComponent(jobId)}/status`,
      );
      if (!pollRes.ok) {
        throw new Error(`Polling detect job failed: ${pollRes.status}`);
      }
      const poll = await pollRes.json();

      if (poll.jobStatus === 'done' || poll.services) {
        return { repoName: poll.repoName ?? repoName, services: poll.services };
      }
      if (poll.jobStatus === 'error') {
        throw new Error(
          poll.error || 'Service detection failed during cloning',
        );
      }

      // Report progress to caller
      if (poll.currentStep) {
        onProgress?.(`${poll.currentStep}…`);
      }
    }

    throw new Error(
      'Repository clone timed out. The repository may be too large or the network is slow. Try again later.',
    );
  }

  async startFullAnalysis(
    repoUrl: string,
    lookbackHours?: number,
    selectedServices?: string[],
    externalCallThreshold?: number,
    confidenceMargin?: number,
  ): Promise<{ jobId: string }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/fra/run-full-analysis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl,
          lookbackHours,
          selectedServices,
          externalCallThreshold,
          confidenceMargin,
        }),
      },
    );
    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(
        err.error || `Failed to start analysis: ${response.status}`,
      );
    }
    return response.json();
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/fra/job/${encodeURIComponent(jobId)}/status`,
    );
    if (!response.ok) {
      throw new Error(`Job not found: ${response.status}`);
    }
    return response.json();
  }

  async getAnalysis(
    lookback: string,
    services?: string[],
  ): Promise<RelocationResult[]> {
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
