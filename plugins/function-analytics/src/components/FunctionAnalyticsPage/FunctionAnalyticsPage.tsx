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

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Page,
  Header,
  HeaderLabel,
  Content,
  ContentHeader,
  Progress,
} from '@backstage/core-components';
import { useApi, discoveryApiRef } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { fetchApiRef } from '@backstage/core-plugin-api';
import {
  Card,
  CardContent,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  Box,
  Tabs,
  Tab,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  ListSubheader,
  Button,
} from '@material-ui/core';
import { Alert, AlertTitle } from '@material-ui/lab';
import RefreshIcon from '@material-ui/icons/Refresh';
import SettingsIcon from '@material-ui/icons/Settings';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import CancelIcon from '@material-ui/icons/Cancel';
import CloudQueueIcon from '@material-ui/icons/CloudQueue';
import StorageIcon from '@material-ui/icons/Storage';

// Import types
import {
  PluginMode,
  CatalogServiceConfig,
  ManualServiceConfig,
  TracingBackendConfig,
  HybridServiceConfig,
  FunctionCall,
} from './types';

// Import services and utilities
import {
  getCatalogInstrumentedServices,
  getDefaultTracingBackends,
} from './catalogService';
import { fetchHybridServiceMetrics } from './dataFetcher';
import { useStyles } from './styles';

// Import components
import { TabPanel } from './components/TabPanel';
import { ServiceDiscoveryStatus } from './components/ServiceDiscoveryStatus';
import { ConfigurationDialog } from './components/ConfigurationDialog';
import { AddServiceDialog } from './components/AddServiceDialog';
import { GroupTraceResultsDisplay } from './components/GroupTraceResultsDisplay';
import { DataFlowVisualization } from './components/DataFlowVisualization';
import { MicroserviceConfigWizard } from '../MicroserviceConfigWizard';
import { TraceViewer } from '../TraceViewer';

/**
 * Helper function to determine row class based on risk level
 */
const getRowClassName = (
  securityRisk: 'HIGH' | 'MEDIUM' | 'LOW',
  shouldRelocate: boolean,
  classes: any,
): string => {
  if (securityRisk === 'HIGH') return classes.misplacedHighRisk;
  if (securityRisk === 'MEDIUM') return classes.misplacedMediumRisk;
  if (shouldRelocate) return classes.misplacedLowRisk;
  return classes.wellPlaced;
};

/**
 * Helper function to determine chip color based on risk level
 */
const getChipColor = (
  securityRisk: 'HIGH' | 'MEDIUM' | 'LOW',
): 'primary' | 'secondary' | 'default' => {
  if (securityRisk === 'HIGH') return 'secondary';
  if (securityRisk === 'MEDIUM') return 'default';
  return 'primary';
};

/**
 * Main Function Analytics Page Component
 * Provides hybrid service discovery, tracing analysis, and function placement recommendations
 */
export const FunctionAnalyticsPage = () => {
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const catalogApi = useApi(catalogApiRef);
  const fetchApi = useApi(fetchApiRef);

  // Use localStorage to preserve UI state across app-config.yaml hot-reloads
  const [tabValue, setTabValue] = useState<number>(() => {
    const saved = localStorage.getItem('fa-tabValue');
    return saved !== null ? parseInt(saved, 10) : 0;
  });
  const [selectedService, setSelectedService] = useState<string>(() => {
    return localStorage.getItem('fa-selectedService') || 'all';
  });

  useEffect(() => {
    localStorage.setItem('fa-tabValue', tabValue.toString());
  }, [tabValue]);

  useEffect(() => {
    localStorage.setItem('fa-selectedService', selectedService);
  }, [selectedService]);

  const [timeRange, setTimeRange] = useState('1h');

  // Plugin configuration state
  const [pluginMode, setPluginMode] = useState<PluginMode>({
    mode: 'hybrid',
    description: 'Auto-discover from catalog + manual configuration',
  });

  // Service configuration state
  const [catalogServices, setCatalogServices] = useState<
    CatalogServiceConfig[]
  >([]);
  const [manualServices, setManualServices] = useState<ManualServiceConfig[]>(
    [],
  );
  const [tracingBackends, setTracingBackends] = useState<
    TracingBackendConfig[]
  >(getDefaultTracingBackends());
  const [selectedBackend, setSelectedBackend] = useState<TracingBackendConfig>(
    getDefaultTracingBackends()[0],
  );

  // Data state
  const [hybridConfigs, setHybridConfigs] = useState<HybridServiceConfig[]>([]);

  // Loading and error states
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showAddServiceDialog, setShowAddServiceDialog] = useState(false);
  const [deployingService, setDeployingService] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<string>('');
  const [groupTracing, setGroupTracing] = useState(false);
  const [groupTraceResults, setGroupTraceResults] = useState<
    Array<{
      serviceName: string;
      jaegerServiceName: string;
      deployStatus: 'started' | 'failed' | 'skipped';
      tracesInJaeger: number;
      traceQueryStatus: 'ok' | 'failed';
      message: string;
      latency?: number;
      startTime?: number;
      endTime?: number;
    }>
  >([]);
  const [groupTraceError, setGroupTraceError] = useState<string | null>(null);
  const [jaegerHealthy, setJaegerHealthy] = useState<boolean | null>(null);

  // Analysis state from the backend
  const [backendAnalysis, setBackendAnalysis] = useState<any[]>([]);

  // Initialize plugin - detect best mode
  useEffect(() => {
    const initializePlugin = async () => {
      setConfigLoading(true);
      try {
        const catalogSvcs = await getCatalogInstrumentedServices(catalogApi);
        setCatalogServices(catalogSvcs);

        const savedManualServices = localStorage.getItem(
          'function-analytics-manual-services',
        );
        if (savedManualServices) {
          setManualServices(JSON.parse(savedManualServices));
        }

        const savedBackends = localStorage.getItem(
          'function-analytics-backends',
        );
        if (savedBackends) {
          const backends = JSON.parse(savedBackends);
          setTracingBackends(backends);
          const activeBackend = backends.find(
            (b: TracingBackendConfig) => b.enabled,
          );
          if (activeBackend) {
            setSelectedBackend(activeBackend);
          }
        }

        if (catalogSvcs.length > 0) {
          setPluginMode({
            mode: 'hybrid',
            description: `Found ${catalogSvcs.length} catalog services`,
          });
        } else {
          setPluginMode({
            mode: 'manual-only',
            description:
              'No catalog services found - manual configuration required',
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Plugin initialization failed:', err);
        setError('Failed to initialize plugin');
      } finally {
        setConfigLoading(false);
      }
    };

    initializePlugin();
  }, [catalogApi]);

  // Fetch data when configuration changes
  useEffect(() => {
    const fetchData = async () => {
      if (configLoading) return;

      setLoading(true);
      setError(null);

      try {
        const proxyBaseUrl = await discoveryApi.getBaseUrl('proxy');
        const configs = await fetchHybridServiceMetrics(
          catalogServices,
          manualServices,
          selectedBackend,
          timeRange,
          fetchApi,
          proxyBaseUrl,
        );

        setHybridConfigs(configs);

        if (configs.length === 0) {
          setError(
            'No services configured or no trace data available. Check Jaeger connection and service instrumentation.',
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error fetching hybrid metrics:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to fetch metrics',
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [
    catalogServices,
    manualServices,
    selectedBackend,
    timeRange,
    configLoading,
    fetchApi,
    discoveryApi,
  ]);

  // Dedicated effect: fetch backend function placement analysis independently
  useEffect(() => {
    const fetchAnalysis = async () => {
      if (configLoading) return;
      try {
        const backendUrl = await discoveryApi.getBaseUrl('function-analytics');
        const queryParams = new URLSearchParams({
          lookback: getLookbackForTimeRange(timeRange),
        }).toString();
        // eslint-disable-next-line no-console
        console.log(
          '🔄 [Analysis] Fetching from:',
          `${backendUrl}/analyze?${queryParams}`,
        );
        const res = await fetchApi.fetch(
          `${backendUrl}/analyze?${queryParams}`,
        );
        if (!res.ok) {
          throw new Error(`Backend returned ${res.status}: ${res.statusText}`);
        }
        const data = await res.json();
        // eslint-disable-next-line no-console
        console.log('[Frontend] 📥 Full analysis data received:', data);
        if (Array.isArray(data)) {
          setBackendAnalysis(data);
        } else if (data.success && data.data) {
          setBackendAnalysis(data.data);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('❌ [Analysis] Failed to fetch backend analysis:', err);
      }
    };

    fetchAnalysis();
  }, [configLoading, fetchApi, discoveryApi, timeRange]);

  // Save manual services to localStorage
  useEffect(() => {
    localStorage.setItem(
      'function-analytics-manual-services',
      JSON.stringify(manualServices),
    );
  }, [manualServices]);

  // Save backends to localStorage
  useEffect(() => {
    localStorage.setItem(
      'function-analytics-backends',
      JSON.stringify(tracingBackends),
    );
  }, [tracingBackends]);

  const handleTabChange = (_: React.ChangeEvent<{}>, newValue: number) => {
    setTabValue(newValue);
  };

  const handleAddManualService = (service: Omit<ManualServiceConfig, 'id'>) => {
    const newService: ManualServiceConfig = {
      ...service,
      id: `manual-${Date.now()}`,
    };
    setManualServices([...manualServices, newService]);
  };

  const handleRemoveManualService = (id: string) => {
    setManualServices(manualServices.filter(s => s.id !== id));
  };

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const proxyBaseUrl = await discoveryApi.getBaseUrl('proxy');
      const configs = await fetchHybridServiceMetrics(
        catalogServices,
        manualServices,
        selectedBackend,
        timeRange,
        fetchApi,
        proxyBaseUrl,
      );
      setHybridConfigs(configs);
      setError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Manual refresh error:', err);
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setLoading(false);
    }

    // Also re-fetch backend analysis
    try {
      const backendUrl = await discoveryApi.getBaseUrl('function-analytics');
      const queryParams = new URLSearchParams({
        lookback: getLookbackForTimeRange(timeRange),
      }).toString();
      // eslint-disable-next-line no-console
      console.log(
        '🔄 [Refresh] Fetching analysis from:',
        `${backendUrl}/analyze?${queryParams}`,
      );
      const res = await fetchApi.fetch(`${backendUrl}/analyze?${queryParams}`);
      if (res.ok) {
        const data = await res.json();
        // eslint-disable-next-line no-console
        console.log(
          '📥 [Refresh] Got',
          Array.isArray(data) ? data.length : 'non-array',
          'results',
        );
        if (Array.isArray(data)) {
          setBackendAnalysis(data);
        }
      }
    } catch (analysisErr) {
      // eslint-disable-next-line no-console
      console.error('❌ [Refresh] Analysis fetch failed:', analysisErr);
    }
  }, [
    catalogServices,
    manualServices,
    selectedBackend,
    timeRange,
    fetchApi,
    discoveryApi,
  ]);

  const handleTestJaeger = async () => {
    // eslint-disable-next-line no-console
    console.log('🔍 Testing Jaeger connection...');
    try {
      const response = await fetchApi.fetch('/api/proxy/jaeger/api/services');
      const data = await response.json();
      // eslint-disable-next-line no-console
      console.log('✅ Jaeger services:', data);
      // eslint-disable-next-line no-alert
      alert(
        `Jaeger connection successful! Found ${
          data.data?.length || 0
        } services.`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('❌ Jaeger connection failed:', err);
      // eslint-disable-next-line no-alert
      alert(
        'Jaeger connection failed. Check if Jaeger is running on localhost:16686',
      );
    }
  };

  const getServiceRepoName = (service: HybridServiceConfig): string => {
    if (service.source === 'catalog' && 'entity' in service.config) {
      const annotations = service.config.entity.metadata.annotations || {};
      // Explicit annotation wins — used by local repos without a GitHub slug
      const explicit = annotations['function-analytics/repo-name'];
      if (explicit) return explicit;
      // Fall back to deriving from GitHub project slug
      const repoSlug = annotations['github.com/project-slug'];
      if (repoSlug) {
        return repoSlug.split('/').pop()?.replace('.git', '') || '';
      }
    }
    return '';
  };

  const getServiceGitHubUrl = (service: HybridServiceConfig): string => {
    if (service.source === 'catalog' && 'entity' in service.config) {
      const repoSlug =
        service.config.entity.metadata.annotations?.['github.com/project-slug'];
      if (repoSlug) {
        // Construct GitHub URL from project slug (e.g., "owner/repo" -> "https://github.com/owner/repo.git")
        return `https://github.com/${repoSlug}.git`;
      }
    }
    return '';
  };

  const getJaegerServiceName = (service: HybridServiceConfig): string => {
    if (service.source === 'catalog' && 'entity' in service.config) {
      return service.config.jaegerServiceName || service.serviceName;
    }
    if (service.source === 'manual') {
      return service.config.jaegerServiceName || service.serviceName;
    }
    return service.serviceName;
  };

  function getLookbackForTimeRange(range: string): string {
    if (range === '5m') return '5m';
    if (range === '24h') return '24h';
    if (range === '7d') return '168h';
    return '1h';
  }

  // Aggregate data for display, explicitly filtering out default backstage catalog noise
  const allServices = hybridConfigs.filter(service => {
    if (service.source === 'catalog' && 'entity' in service.config) {
      const sys = (service.config.entity.spec?.system as string) || 'backstage-core';
      return !['backstage-core', 'podcast', 'artist-engagement-portal', 'audio-playback'].includes(sys);
    }
    return true;
  });

  // Auto-deploy and trace service when selected
  useEffect(() => {
    const autoDeployAndTrace = async () => {
      if (
        !selectedService ||
        selectedService === 'all' ||
        selectedService.startsWith('system:')
      ) {
        setDeployingService(null);
        setDeploymentStatus('');
        return;
      }

      // Show loading immediately
      setDeployingService(selectedService);
      setDeploymentStatus(
        `🔍 Checking if ${selectedService} exists in Jaeger...`,
      );

      try {
        const servicesResponse = await fetchApi.fetch(
          '/api/proxy/jaeger/api/services',
        );
        const servicesData = await servicesResponse.json();
        const availableServices = servicesData.data || [];

        // Find the service config
        const service = allServices.find(
          s => s.serviceName === selectedService,
        );
        if (!service) {
          setDeploymentStatus('');
          setDeployingService(null);
          return;
        }

        let jaegerServiceName = selectedService;
        let repoName = '';

        if (service.source === 'catalog' && 'entity' in service.config) {
          jaegerServiceName =
            service.config.jaegerServiceName || selectedService;
          repoName = getServiceRepoName(service);
        }

        // If service not in Jaeger, auto-deploy
        if (
          !availableServices.includes(jaegerServiceName) &&
          !availableServices.includes(selectedService)
        ) {
          setDeploymentStatus(
            `🚀 Starting Jaeger and microservices containers...`,
          );

          const deployFaUrl = await discoveryApi.getBaseUrl(
            'function-analytics',
          );
          const deployResponse = await fetchApi.fetch(
            `${deployFaUrl}/service/deploy-and-trace`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                serviceName: selectedService,
                jaegerServiceName,
                repoName,
                testEndpoints: (() => {
                  if (
                    service.source === 'catalog' &&
                    'entity' in service.config
                  ) {
                    const epStr =
                      service.config.entity.metadata.annotations?.[
                        'function-analytics/mock-endpoints'
                      ];
                    if (epStr)
                      return epStr.split(',').map((s: string) => s.trim());
                  }
                  return undefined;
                })(),
              }),
            },
          );

          const result = await deployResponse.json();

          if (!result.success) {
            throw new Error(result.error || 'Deployment failed');
          }

          setDeploymentStatus(
            `✅ Deployed! Jaeger: ${
              result.jaegerRunning ? 'Running' : 'Failed'
            } • Generated ${result.tracesInJaeger} traces`,
          );

          setTimeout(() => {
            handleRefresh();
            setDeployingService(null);
            setDeploymentStatus('');
          }, 3000);
        } else {
          setDeploymentStatus(
            `✅ Service "${jaegerServiceName}" is already running`,
          );
          setTimeout(() => {
            setDeployingService(null);
            setDeploymentStatus('');
          }, 2000);
        }
      } catch (err) {
        setDeploymentStatus(
          `❌ Deployment failed: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
        setTimeout(() => {
          setDeployingService(null);
          setDeploymentStatus('');
        }, 5000);
      }
    };

    autoDeployAndTrace();
  }, [selectedService, allServices, fetchApi, handleRefresh, discoveryApi]);

  const filteredFunctions: FunctionCall[] = (() => {
    if (!selectedService || selectedService === 'all') {
      return allServices.flatMap(service => service.functions || []);
    }

    // Check if it's a system group (starts with 'system:')
    if (selectedService.startsWith('system:')) {
      const systemName = selectedService.replace('system:', '');
      return allServices
        .filter(service => {
          if (service.source === 'catalog' && 'entity' in service.config) {
            const serviceSystem =
              (service.config.entity.spec?.system as string) ||
              'backstage-core';
            return serviceSystem === systemName;
          }
          if (service.source === 'manual' && systemName === 'manual-services') {
            return true;
          }
          if (
            systemName === 'backstage-core' &&
            service.source === 'catalog' &&
            'entity' in service.config
          ) {
            const serviceSystem = service.config.entity.spec?.system as string;
            return !serviceSystem || serviceSystem === 'backstage-core';
          }
          return false;
        })
        .flatMap(service => service.functions || []);
    }

    // Individual service
    return allServices
      .filter(service => service.serviceName === selectedService)
      .flatMap(service => service.functions || []);
  })();

  const totalCalls = allServices.reduce(
    (sum, service) => sum + service.totalCalls,
    0,
  );
  const avgLatency =
    allServices.length > 0
      ? allServices.reduce((sum, service) => sum + service.avgLatency, 0) /
        allServices.length
      : 0;
  const criticalFunctions = filteredFunctions.filter(
    func => func.errorRate > 1 || func.latency > 100,
  );
  const catalogServiceCount = allServices.filter(
    s => s.source === 'catalog',
  ).length;
  const manualServiceCount = allServices.filter(
    s => s.source === 'manual',
  ).length;
  const misplacedFunctions = backendAnalysis.filter(
    (analysis: any) => analysis.recommendation === 'relocate',
  );
  const selectedGroupServices = useMemo(() => {
    if (!selectedService.startsWith('system:')) {
      return [];
    }

    return allServices.filter(service => {
      const systemName = selectedService.replace('system:', '');
      if (service.source === 'catalog' && 'entity' in service.config) {
        const serviceSystem =
          (service.config.entity.spec?.system as string) || 'backstage-core';
        if (systemName === 'backstage-core') {
          return (
            !service.config.entity.spec?.system ||
            serviceSystem === 'backstage-core'
          );
        }
        return serviceSystem === systemName;
      }
      return service.source === 'manual' && systemName === 'manual-services';
    });
  }, [allServices, selectedService]);

  // Fuzzy match between Jaeger service name (currentService) and catalog service name.
  // Repos often differ: "auth" vs "lightweight-auth" vs "auth-service".
  // Strip "-service"/"-api" suffixes and common repo prefixes before comparing.
  const svcNameMatch = (
    currentService: string,
    catalogName: string,
  ): boolean => {
    if (currentService === catalogName) return true;
    const strip = (s: string) =>
      s
        .toLowerCase()
        .replace(/-service$/, '')
        .replace(/-api$/, '');
    const a = strip(currentService);
    const b = strip(catalogName);
    // Exact after stripping ("auth-service" ↔ "auth", "auth" ↔ "auth")
    if (a === b) return true;
    // Prefix/suffix: "lightweight-auth" ends with "-auth" ↔ "auth"
    if (b.endsWith(`-${a}`) || a.endsWith(`-${b}`)) return true;
    if (b.startsWith(`${a}-`) || a.startsWith(`${b}-`)) return true;
    return false;
  };

  // Filter analysis results to only show services relevant to the current selection:
  // - system selected  → only services belonging to that system
  // - single service   → only that service
  // - 'all'            → everything
  const filteredAnalysis: any[] = (() => {
    if (selectedService === 'all') return backendAnalysis;
    if (selectedService.startsWith('system:')) {
      const names = selectedGroupServices.map(s => s.serviceName);
      return backendAnalysis.filter((a: any) =>
        names.some(n => svcNameMatch(a.currentService, n)),
      );
    }
    return backendAnalysis.filter((a: any) =>
      svcNameMatch(a.currentService, selectedService),
    );
  })();

  const handleStartGroupTracing = useCallback(async () => {
    if (
      !selectedService.startsWith('system:') ||
      selectedGroupServices.length === 0
    ) {
      return;
    }

    setGroupTracing(true);
    setGroupTraceError(null);
    setGroupTraceResults([]);

    try {
      // eslint-disable-next-line no-console
      console.log(`🚀 Starting group tracing for system: ${selectedService}`);

      // Start repo containers first so Jaeger + services are up before per-service trace checks.
      const repoNames = Array.from(
        new Set(
          selectedGroupServices
            .map(service => getServiceRepoName(service))
            .filter(Boolean),
        ),
      );

      for (const repoName of repoNames) {
        try {
          // Find a service from this repo to get GitHub URL
          const repoService = selectedGroupServices.find(
            s => getServiceRepoName(s) === repoName,
          );
          const gitHubUrl = repoService ? getServiceGitHubUrl(repoService) : '';

          const faBackendUrl = await discoveryApi.getBaseUrl(
            'function-analytics',
          );
          const deployAllResp = await fetchApi.fetch(
            `${faBackendUrl}/service/deploy-all-and-trace`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoName, gitHubUrl }),
            },
          );
          if (!deployAllResp.ok) {
            // eslint-disable-next-line no-console
            console.warn(
              `Failed to pre-deploy repo ${repoName}: ${deployAllResp.status}`,
            );
          }
        } catch (deployAllErr) {
          // eslint-disable-next-line no-console
          console.warn(`Failed to pre-deploy repo ${repoName}:`, deployAllErr);
        }
      }

      // Ensure Jaeger is started via backend before querying traces.
      try {
        // Attempt to find a repoName from group services (type-safe)
        let repoCandidate: string | undefined;
        for (const s of selectedGroupServices) {
          if (
            s &&
            s.source === 'catalog' &&
            typeof (s.config as any).entity !== 'undefined'
          ) {
            const repoSlug = (s.config as any).entity?.metadata?.annotations?.[
              'github.com/project-slug'
            ];
            if (repoSlug) {
              repoCandidate = String(repoSlug)
                .split('/')
                .pop()
                ?.replace('.git', '');
              break;
            }
          }
        }

        const startJaegerFaUrl = await discoveryApi.getBaseUrl(
          'function-analytics',
        );
        const startJaegerResp = await fetchApi.fetch(
          `${startJaegerFaUrl}/service/start-jaeger`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoName: repoCandidate || '' }),
          },
        );
        if (startJaegerResp.ok) {
          // eslint-disable-next-line no-console
          console.log('✅ Requested backend to start Jaeger');
          setJaegerHealthy(true);
        } else {
          // eslint-disable-next-line no-console
          console.warn('⚠️ start-jaeger returned non-ok');
        }
      } catch (startErr) {
        // eslint-disable-next-line no-console
        console.warn('⚠️ Failed to start Jaeger via backend:', startErr);
      }

      const jaegerServicesResponse = await fetchApi.fetch(
        '/api/proxy/jaeger/api/services',
      );
      if (!jaegerServicesResponse.ok) {
        throw new Error(
          `Jaeger service check failed: ${jaegerServicesResponse.status}`,
        );
      }
      setJaegerHealthy(true);
      // eslint-disable-next-line no-console
      console.log('✅ Jaeger is healthy and reachable');

      const lookback = getLookbackForTimeRange(timeRange);
      const results: Array<{
        serviceName: string;
        jaegerServiceName: string;
        deployStatus: 'started' | 'failed' | 'skipped';
        tracesInJaeger: number;
        traceQueryStatus: 'ok' | 'failed';
        message: string;
        latency?: number;
        startTime?: number;
        endTime?: number;
      }> = [];

      const parseJsonOrThrow = async (
        response: Response,
        context: string,
      ): Promise<any> => {
        const contentType = response.headers.get('content-type') || '';
        const payload = await response.text();

        if (!response.ok) {
          throw new Error(
            `${context} failed (${response.status}): ${payload.slice(0, 200)}`,
          );
        }

        if (!contentType.includes('application/json')) {
          const sample = payload.replace(/\s+/g, ' ').slice(0, 140);
          throw new Error(`${context} returned non-JSON response: ${sample}`);
        }

        try {
          return JSON.parse(payload);
        } catch {
          const sample = payload.replace(/\s+/g, ' ').slice(0, 140);
          throw new Error(`${context} returned invalid JSON: ${sample}`);
        }
      };

      for (const service of selectedGroupServices) {
        const startTime = Date.now();
        let jaegerServiceName = getJaegerServiceName(service);
        let deployStatus: 'started' | 'failed' | 'skipped' = 'skipped';
        let tracesInJaeger = 0;
        let traceQueryStatus: 'ok' | 'failed' = 'ok';
        let message = '';

        try {
          // eslint-disable-next-line no-console
          console.log(`📦 Deploying service: ${service.serviceName}`);

          const deployFaUrl = await discoveryApi.getBaseUrl(
            'function-analytics',
          );
          const deployResponse = await fetchApi.fetch(
            `${deployFaUrl}/service/deploy-and-trace`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                serviceName: service.serviceName,
                jaegerServiceName,
                repoName: getServiceRepoName(service),
                testEndpoints: (() => {
                  if (
                    service.source === 'catalog' &&
                    'entity' in service.config
                  ) {
                    const epStr =
                      service.config.entity.metadata.annotations?.[
                        'function-analytics/mock-endpoints'
                      ];
                    if (epStr)
                      return epStr.split(',').map((s: string) => s.trim());
                  }
                  return undefined;
                })(),
              }),
            },
          );
          const deployResult = await parseJsonOrThrow(
            deployResponse as Response,
            `Deploy ${service.serviceName}`,
          );

          if (!deployResult.success) {
            throw new Error(deployResult.error || 'Deploy failed');
          }

          deployStatus = 'started';
          // eslint-disable-next-line no-console
          console.log(`✅ Service deployed: ${service.serviceName}`);
          // Use the backend-resolved jaegerServiceName (reads actual OTEL_SERVICE_NAME from compose)
          // so we query Jaeger with the right name (e.g. 'auth-service' vs 'auth').
          if (deployResult.jaegerServiceName) {
            jaegerServiceName = deployResult.jaegerServiceName;
          }
          message = `Tracing started; generated ${
            deployResult.tracesInJaeger || deployResult.tracesGenerated || 0
          } traces`;
        } catch (deployErr) {
          deployStatus = 'failed';
          message =
            deployErr instanceof Error
              ? deployErr.message
              : 'Deployment failed';
          // eslint-disable-next-line no-console
          console.error(
            `❌ Deployment failed for ${service.serviceName}:`,
            deployErr,
          );
        }

        // Query traces from Jaeger
        try {
          // eslint-disable-next-line no-console
          console.log(`🔍 Querying traces for: ${jaegerServiceName}`);

          const proxyBaseUrl = await discoveryApi.getBaseUrl('proxy');
          const tracesResponse = await fetchApi.fetch(
            `${proxyBaseUrl}/jaeger/api/traces?service=${encodeURIComponent(
              jaegerServiceName,
            )}&lookback=${lookback}&limit=100`,
          );
          const tracesData = await parseJsonOrThrow(
            tracesResponse as Response,
            `Jaeger query ${jaegerServiceName}`,
          );
          tracesInJaeger = tracesData.data?.length || 0;
          // eslint-disable-next-line no-console
          console.log(
            `📊 Found ${tracesInJaeger} traces for ${jaegerServiceName}`,
          );
        } catch (traceErr) {
          traceQueryStatus = 'failed';
          if (message) {
            message = `${message} | Jaeger trace query failed`;
          } else if (traceErr instanceof Error) {
            message = traceErr.message;
          } else {
            message = 'Jaeger trace query failed';
          }
          // eslint-disable-next-line no-console
          console.warn(
            `⚠️ Trace query failed for ${jaegerServiceName}:`,
            traceErr,
          );
        }

        // Calculate latency and update message
        const endTime = Date.now();
        const latency = endTime - startTime;

        if (tracesInJaeger > 0 && deployStatus !== 'failed') {
          message = `✅ OK - ${tracesInJaeger} traces available in Jaeger (${latency}ms)`;
        } else if (tracesInJaeger > 0 && deployStatus === 'failed') {
          message = `✅ Traces exist (${tracesInJaeger}) but deployment failed (${latency}ms)`;
        } else if (deployStatus === 'started') {
          message = `⏳ Service deployed but no traces yet (${latency}ms) - collecting data...`;
        }

        results.push({
          serviceName: service.serviceName,
          jaegerServiceName,
          deployStatus,
          tracesInJaeger,
          traceQueryStatus,
          message: message || 'No traces found yet',
          latency,
          startTime,
          endTime,
        });
      }

      setGroupTraceResults(results);
      // eslint-disable-next-line no-console
      console.log('✅ Group tracing completed, refreshing data...');

      // Auto-refresh data after successful tracing
      await new Promise(resolve => setTimeout(resolve, 2000));
      await handleRefresh();
    } catch (err) {
      setJaegerHealthy(false);
      const errorMsg =
        err instanceof Error ? err.message : 'Group tracing failed';
      setGroupTraceError(errorMsg);
      // eslint-disable-next-line no-console
      console.error('❌ Group tracing error:', err);
    } finally {
      setGroupTracing(false);
    }
  }, [
    fetchApi,
    handleRefresh,
    selectedGroupServices,
    selectedService,
    timeRange,
    discoveryApi,
  ]);

  if (configLoading) {
    return <Progress />;
  }

  if (loading) {
    return <Progress />;
  }

  return (
    <Page themeId="tool">
      <Header
        title="Function Analytics"
        subtitle={`Hybrid tracing analysis - ${pluginMode.description}`}
      >
        <HeaderLabel label="Mode" value={pluginMode.mode.toUpperCase()} />
        <HeaderLabel label="Services" value={`${allServices.length} total`} />
        <HeaderLabel
          label="Last Updated"
          value={new Date().toLocaleTimeString()}
        />
      </Header>

      <Content>
        {/* Show deployment status with loading */}
        {deployingService && deploymentStatus && (
          <Card
            style={{
              marginBottom: 16,
              backgroundColor: deploymentStatus.includes('✅')
                ? '#e8f5e9'
                : '#fff3e0',
            }}
          >
            <CardContent>
              <Box display="flex" alignItems="center" style={{ gap: 16 }}>
                {!deploymentStatus.includes('✅') &&
                  !deploymentStatus.includes('❌') && (
                    <Box>
                      <Progress />
                    </Box>
                  )}
                <Box flex={1}>
                  <Typography variant="h6" gutterBottom>
                    Deployment Status
                  </Typography>
                  <Typography variant="body1" style={{ fontWeight: 500 }}>
                    {deploymentStatus}
                  </Typography>
                  {deploymentStatus.includes('🚀') && (
                    <Box mt={2}>
                      <Typography variant="body2" color="textSecondary">
                        • Starting Jaeger container (http://localhost:16686)
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        • Starting all microservice containers
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        • Generating HTTP requests to create traces
                      </Typography>
                      <Typography
                        variant="body2"
                        color="textSecondary"
                        style={{ marginTop: 8, fontStyle: 'italic' }}
                      >
                        Please wait 30-60 seconds...
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
            </CardContent>
          </Card>
        )}

        <ServiceDiscoveryStatus
          allServices={allServices}
          catalogServiceCount={catalogServiceCount}
          manualServiceCount={manualServiceCount}
          onConfigureClick={() => setShowConfigDialog(true)}
          onAddServiceClick={() => setShowAddServiceDialog(true)}
          onTestJaeger={handleTestJaeger}
        />

        <ContentHeader title="Function-Level Performance Analytics">
          <Box display="flex" style={{ gap: '16px' }}>
            <FormControl
              variant="outlined"
              size="small"
              style={{ minWidth: 300 }}
            >
              <InputLabel>Service</InputLabel>
              <Select
                value={selectedService}
                onChange={e => setSelectedService(e.target.value as string)}
                label="Service"
                MenuProps={{
                  PaperProps: { className: classes.selectMenuPaper },
                  MenuListProps: { className: classes.selectMenuList },
                }}
              >
                <MenuItem value="all">All Services</MenuItem>
                {(() => {
                  // Group services by system
                  const servicesBySystem = new Map<
                    string,
                    typeof allServices
                  >();

                  allServices.forEach(service => {
                    let systemName: string;
                    if (
                      service.source === 'catalog' &&
                      'entity' in service.config
                    ) {
                      systemName =
                        (service.config.entity.spec?.system as string) ||
                        'backstage-core';
                    } else if (service.source === 'manual') {
                      systemName = 'manual-services';
                    } else {
                      systemName = 'backstage-core';
                    }

                    if (!servicesBySystem.has(systemName)) {
                      servicesBySystem.set(systemName, []);
                    }
                    servicesBySystem.get(systemName)!.push(service);
                  });

                  // Sort: microservice systems first, then manual, then backstage-core
                  const sortedSystems = Array.from(
                    servicesBySystem.entries(),
                  )
                    .filter(
                      ([sys]) =>
                        !['backstage-core', 'podcast', 'artist-engagement-portal'].includes(sys)
                    )
                    .sort(([a], [b]) => {
                      if (a === 'manual-services') return 1;
                      if (b === 'manual-services') return -1;
                      return a.localeCompare(b);
                    });

                  return sortedSystems.flatMap(([systemName, services]) => {
                    let systemTitle: string;
                    if (systemName === 'backstage-core') {
                      systemTitle = 'Backstage Core Services';
                    } else if (systemName === 'manual-services') {
                      systemTitle = 'Manual Services';
                    } else {
                      systemTitle = systemName
                        .split('-')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(' ');
                    }

                    // Calculate total services and functions in this system
                    const totalServices = services.length;
                    const totalFunctions = services.reduce(
                      (sum, s) => sum + (s.functions?.length || 0),
                      0,
                    );

                    return [
                      <ListSubheader
                        key={`header-${systemName}`}
                        className={classes.selectSubheader}
                      >
                        📦 {systemTitle}
                      </ListSubheader>,

                      // Add system group option
                      <MenuItem
                        key={`system-${systemName}`}
                        value={`system:${systemName}`}
                        className={classes.selectSystemItem}
                      >
                        <Box
                          display="flex"
                          alignItems="center"
                          justifyContent="space-between"
                          width="100%"
                        >
                          <Box
                            display="flex"
                            alignItems="center"
                            style={{ gap: 8 }}
                          >
                            <CheckCircleIcon fontSize="small" color="primary" />
                            <em>All {systemTitle}</em>
                          </Box>
                          <Chip
                            label={`${totalServices} services • ${totalFunctions} functions`}
                            size="small"
                            style={{
                              height: 20,
                              fontSize: '0.7rem',
                              marginLeft: 8,
                            }}
                            color="primary"
                          />
                        </Box>
                      </MenuItem>,

                      // Individual services
                      ...services.map(service => (
                        <MenuItem
                          key={service.serviceName}
                          value={service.serviceName}
                          className={classes.selectServiceItem}
                        >
                          <Box
                            display="flex"
                            alignItems="center"
                            justifyContent="space-between"
                            width="100%"
                          >
                            <Box
                              display="flex"
                              alignItems="center"
                              style={{ gap: 8 }}
                            >
                              {service.source === 'catalog' ? (
                                <CloudQueueIcon fontSize="small" />
                              ) : (
                                <StorageIcon fontSize="small" />
                              )}
                              {service.serviceName}
                            </Box>
                            <Box
                              display="flex"
                              alignItems="center"
                              style={{ gap: 4 }}
                            >
                              {service.source === 'catalog' &&
                                'entity' in service.config && (
                                  <Chip
                                    label={
                                      service.config.entity.metadata.description
                                        ?.match(/(nodejs|python|go|java)/i)?.[0]
                                        ?.toUpperCase() || 'API'
                                    }
                                    size="small"
                                    style={{ height: 20, fontSize: '0.7rem' }}
                                    color="primary"
                                  />
                                )}
                              <Chip
                                label={`${
                                  service.functions?.length || 0
                                } functions`}
                                size="small"
                                style={{ height: 20, fontSize: '0.7rem' }}
                                variant="outlined"
                              />
                            </Box>
                          </Box>
                        </MenuItem>
                      )),
                    ];
                  });
                })()}
              </Select>
            </FormControl>

            <FormControl
              variant="outlined"
              size="small"
              style={{ minWidth: 100 }}
            >
              <InputLabel>Time Range</InputLabel>
              <Select
                value={timeRange}
                onChange={e => setTimeRange(e.target.value as string)}
                label="Time Range"
                MenuProps={{
                  PaperProps: { className: classes.selectMenuPaper },
                  MenuListProps: { className: classes.selectMenuList },
                }}
              >
                <MenuItem value="5m">5 minutes</MenuItem>
                <MenuItem value="1h">1 hour</MenuItem>
                <MenuItem value="24h">24 hours</MenuItem>
                <MenuItem value="7d">7 days</MenuItem>
              </Select>
            </FormControl>

            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={handleRefresh}
              disabled={loading}
            >
              Refresh
            </Button>

            <Button
              variant="outlined"
              startIcon={<SettingsIcon />}
              onClick={() => setShowConfigDialog(true)}
            >
              Configure
            </Button>
          </Box>

          {error && (
            <Box mt={2}>
              <Alert severity="error">
                <AlertTitle>Configuration Error</AlertTitle>
                {error}
              </Alert>
            </Box>
          )}
        </ContentHeader>

        <Paper>
          <Tabs
            value={tabValue}
            onChange={handleTabChange}
            indicatorColor="primary"
            textColor="primary"
          >
            <Tab label="Configure Services" />
            <Tab label="Trace Viewer" />
            <Tab label="Function Details" />
            <Tab label="Service Overview" />
            <Tab label="Function Placement Analysis" />
          </Tabs>

          {/* Tab 0: Configuration Wizard */}
          <TabPanel value={tabValue} index={0}>
            <MicroserviceConfigWizard 
              onDeployComplete={(systemName) => {
                setSelectedService(systemName);
                setTabValue(1);
              }} 
            />
          </TabPanel>

          {/* Tab 1: Trace Viewer */}
          <TabPanel value={tabValue} index={1}>
            {(() => {
              if (!selectedService || selectedService === 'all') {
                return (
                  <Box p={3}>
                    <Alert severity="info">
                      <Typography variant="body1">
                        Please select a service or service group from the
                        dropdown above.
                      </Typography>
                      <Typography variant="body2" style={{ marginTop: 8 }}>
                        Select an individual service to inspect traces, or a
                        group to start tracing for the full group.
                      </Typography>
                    </Alert>
                  </Box>
                );
              }

              if (selectedService.startsWith('system:')) {
                let jaegerHealthLabel = 'Jaeger: unknown';
                if (jaegerHealthy === true) {
                  jaegerHealthLabel = 'Jaeger: healthy';
                } else if (jaegerHealthy === false) {
                  jaegerHealthLabel = 'Jaeger: unreachable';
                }

                return (
                  <Box p={3}>
                    <Alert severity="info" style={{ marginBottom: 16 }}>
                      <Typography variant="body1">
                        Group selected: {selectedService.replace('system:', '')}
                      </Typography>
                      <Typography variant="body2" style={{ marginTop: 8 }}>
                        Start tracing for all services in this group, then
                        verify OpenTelemetry and Jaeger flow from this panel.
                      </Typography>
                      <Box
                        mt={2}
                        display="flex"
                        alignItems="center"
                        style={{ gap: 12 }}
                      >
                        <Button
                          variant="contained"
                          color="primary"
                          onClick={handleStartGroupTracing}
                          disabled={
                            groupTracing || selectedGroupServices.length === 0
                          }
                        >
                          {groupTracing
                            ? 'Starting Tracing...'
                            : 'Start Tracing for Group'}
                        </Button>
                        <Chip
                          size="small"
                          label={jaegerHealthLabel}
                          color={jaegerHealthy ? 'primary' : 'default'}
                        />
                        <Chip
                          size="small"
                          label={`Services: ${selectedGroupServices.length}`}
                          variant="outlined"
                        />
                      </Box>
                    </Alert>

                    {groupTraceError && (
                      <Alert severity="error" style={{ marginBottom: 16 }}>
                        {groupTraceError}
                      </Alert>
                    )}

                    <Box mt={2}>
                      <DataFlowVisualization
                        jaegerHealthy={jaegerHealthy}
                        tracesCollected={groupTraceResults.reduce(
                          (s, r) => s + r.tracesInJaeger,
                          0,
                        )}
                        servicesDeployed={selectedGroupServices.length}
                        isTracing={groupTracing}
                      />

                      <GroupTraceResultsDisplay
                        results={groupTraceResults.map(r => ({
                          serviceName: r.serviceName,
                          jaegerServiceName: r.jaegerServiceName,
                          deployStatus: r.deployStatus,
                          tracesInJaeger: r.tracesInJaeger,
                          traceQueryStatus: r.traceQueryStatus,
                          message: r.message,
                          startTime: r.startTime,
                          endTime: r.endTime,
                          latency: r.latency,
                        }))}
                        isLoading={groupTracing}
                        error={groupTraceError}
                        jaegerHealthy={jaegerHealthy}
                        systemName={selectedService.replace('system:', '')}
                      />
                    </Box>
                  </Box>
                );
              }

              // Find the service config to get the correct Jaeger service name and repo
              const service = allServices.find(
                s => s.serviceName === selectedService,
              );
              let jaegerServiceName = selectedService;
              let repoName = '';

              if (
                service &&
                service.source === 'catalog' &&
                'entity' in service.config
              ) {
                // Use the jaegerServiceName from catalog config if available
                jaegerServiceName =
                  service.config.jaegerServiceName || selectedService;
                // Get repo name from catalog metadata
                repoName = getServiceRepoName(service);
              }
              // For manual services without catalog metadata, auto-start is skipped
              // (repoName will remain empty)

              return (
                <TraceViewer
                  serviceName={jaegerServiceName}
                  timeRange={timeRange}
                  repoName={repoName}
                />
              );
            })()}
          </TabPanel>

          {/* Tab 2: Function Details */}
          <TabPanel value={tabValue} index={2}>
            <TableContainer className={classes.tableContainer}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Function Name</TableCell>
                    <TableCell>Service</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Microservice Type</TableCell>
                    <TableCell>HTTP Method</TableCell>
                    <TableCell>Latency (ms)</TableCell>
                    <TableCell>Error Rate (%)</TableCell>
                    <TableCell>Call Count</TableCell>
                    <TableCell>Dependencies</TableCell>
                  </TableRow>
                </TableHead>

                <TableBody>
                  {filteredFunctions.length > 0 ? (
                    filteredFunctions.map((func, index) => {
                      const service = allServices.find(
                        s => s.serviceName === func.serviceName,
                      );
                      return (
                        <TableRow
                          key={index}
                          className={
                            service?.source === 'catalog'
                              ? classes.catalogService
                              : classes.manualService
                          }
                        >
                          <TableCell>{func.functionName}</TableCell>
                          <TableCell>{func.serviceName}</TableCell>
                          <TableCell>
                            <Chip
                              icon={
                                service?.source === 'catalog' ? (
                                  <CloudQueueIcon />
                                ) : (
                                  <StorageIcon />
                                )
                              }
                              label={service?.source || 'unknown'}
                              size="small"
                              className={classes.serviceSourceChip}
                              color={
                                service?.source === 'catalog'
                                  ? 'primary'
                                  : 'secondary'
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={func.type}
                              color={
                                func.type === 'external'
                                  ? 'secondary'
                                  : 'primary'
                              }
                              size="small"
                            />
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={func.microserviceType || 'service'}
                              color="default"
                              size="small"
                            />
                          </TableCell>
                          <TableCell>
                            {func.httpMethod ? (
                              <Chip
                                label={func.httpMethod}
                                color="primary"
                                size="small"
                              />
                            ) : (
                              '-'
                            )}
                          </TableCell>
                          <TableCell>{func.latency.toFixed(1)}</TableCell>
                          <TableCell>{func.errorRate.toFixed(2)}</TableCell>
                          <TableCell>{func.callCount}</TableCell>
                          <TableCell>{func.dependencies.join(', ')}</TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={10}
                        style={{ textAlign: 'center', padding: '40px' }}
                      >
                        <Typography color="textSecondary">
                          No function data available. Configure services to
                          start analyzing traces.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>

          {/* Tab 3: Service Overview */}
          <TabPanel value={tabValue} index={3}>
            <Typography variant="h6" gutterBottom>
              Service Overview - Hybrid Configuration
            </Typography>
            <TableContainer className={classes.tableContainer}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Service Name</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Owner</TableCell>
                    <TableCell>Environment</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Total Calls</TableCell>
                    <TableCell>Avg Latency (ms)</TableCell>
                    <TableCell>Error Rate (%)</TableCell>
                    <TableCell>Functions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...allServices]
                    .sort((a, b) => {
                      if (
                        a.connectionStatus === 'connected' &&
                        b.connectionStatus !== 'connected'
                      )
                        return -1;
                      if (
                        a.connectionStatus !== 'connected' &&
                        b.connectionStatus === 'connected'
                      )
                        return 1;
                      return 0;
                    })
                    .map((service, index) => (
                      <TableRow
                        key={index}
                        className={
                          service.source === 'catalog'
                            ? classes.catalogService
                            : classes.manualService
                        }
                      >
                        <TableCell>{service.serviceName}</TableCell>
                        <TableCell>
                          <Chip
                            icon={
                              service.source === 'catalog' ? (
                                <CloudQueueIcon />
                              ) : (
                                <StorageIcon />
                              )
                            }
                            label={service.source}
                            size="small"
                            color={
                              service.source === 'catalog'
                                ? 'primary'
                                : 'secondary'
                            }
                          />
                        </TableCell>
                        <TableCell>{service.owner || 'Unknown'}</TableCell>
                        <TableCell>
                          {service.environment || 'Unknown'}
                        </TableCell>
                        <TableCell>
                          <Chip
                            icon={
                              service.connectionStatus === 'connected' ? (
                                <CheckCircleIcon />
                              ) : (
                                <CancelIcon />
                              )
                            }
                            label={service.connectionStatus}
                            size="small"
                            color={
                              service.connectionStatus === 'connected'
                                ? 'primary'
                                : 'default'
                            }
                          />
                        </TableCell>
                        <TableCell>{service.totalCalls}</TableCell>
                        <TableCell>{service.avgLatency.toFixed(1)}</TableCell>
                        <TableCell>{service.errorRate.toFixed(2)}</TableCell>
                        <TableCell>{service.functions.length}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>

          {/* Tab 4: Function Placement Analysis */}
          <TabPanel value={tabValue} index={4}>
            <Typography variant="h6" gutterBottom>
              Function Placement Analysis - Identify Misplaced Functions
            </Typography>
            <TableContainer className={classes.tableContainer}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Function Name</TableCell>
                    <TableCell>Current Service</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Internal Calls %</TableCell>
                    <TableCell>External Calls %</TableCell>
                    <TableCell>Risk Level</TableCell>
                    <TableCell>Recommended Action</TableCell>
                    <TableCell>Suggested Target Service</TableCell>
                    <TableCell>Latency Impact (ms)</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredAnalysis.length > 0 ? (
                    filteredAnalysis.map((analysis: any, index: number) => {
                      const service = allServices.find(
                        s => s.serviceName === analysis.currentService,
                      );

                      const totalCallsForAnalysis =
                        analysis.internalCalls + analysis.externalCalls;
                      const internalPerc =
                        totalCallsForAnalysis > 0
                          ? (analysis.internalCalls / totalCallsForAnalysis) *
                            100
                          : 0;
                      const externalPerc =
                        totalCallsForAnalysis > 0
                          ? (analysis.externalCalls / totalCallsForAnalysis) *
                            100
                          : 0;

                      let riskLevel = 'LOW';
                      if (analysis.recommendation === 'relocate') {
                        riskLevel = externalPerc > 85 ? 'HIGH' : 'MEDIUM';
                      }

                      let recLabel = 'Keep';
                      if (analysis.recommendation === 'relocate')
                        recLabel = 'Relocate';
                      else if (analysis.recommendation === 'review')
                        recLabel = 'Review Architecture';

                      return (
                        <TableRow
                          key={index}
                          className={getRowClassName(
                            riskLevel as any,
                            analysis.recommendation === 'relocate',
                            classes,
                          )}
                        >
                          <TableCell>{analysis.functionName}</TableCell>
                          <TableCell>{analysis.currentService}</TableCell>
                          <TableCell>
                            <Chip
                              icon={
                                service?.source === 'catalog' ? (
                                  <CloudQueueIcon />
                                ) : (
                                  <StorageIcon />
                                )
                              }
                              label={service?.source || 'unknown'}
                              size="small"
                              className={classes.serviceSourceChip}
                            />
                          </TableCell>
                          <TableCell>
                            {internalPerc.toFixed(1)}% ({analysis.internalCalls}
                            )
                          </TableCell>
                          <TableCell>
                            {externalPerc.toFixed(1)}% ({analysis.externalCalls}
                            )
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={riskLevel}
                              color={getChipColor(riskLevel as any)}
                              size="small"
                            />
                          </TableCell>
                          <TableCell>{recLabel}</TableCell>
                          <TableCell>
                            {analysis.suggestedService || 'N/A'}
                          </TableCell>
                          <TableCell>
                            {analysis.predictedLatencyImprovement
                              ? analysis.predictedLatencyImprovement.toFixed(2)
                              : '0.00'}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        style={{ textAlign: 'center', padding: '40px' }}
                      >
                        <Typography color="textSecondary">
                          {(() => {
                            const subject = selectedService.startsWith(
                              'system:',
                            )
                              ? 'system'
                              : 'service';
                            if (loading) return '⏳ Loading analysis data...';
                            if (backendAnalysis.length > 0)
                              return `⚠️ No analysis data for the selected ${subject}. Try selecting a different service or running traces first.`;
                            return '⚠️ No function placement data yet. Run group tracing first, then click Refresh.';
                          })()}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>
        </Paper>

        {/* Dialogs */}
        <ConfigurationDialog
          open={showConfigDialog}
          onClose={() => setShowConfigDialog(false)}
          catalogServices={catalogServices}
          manualServices={manualServices}
          tracingBackends={tracingBackends}
          catalogServiceCount={catalogServiceCount}
          manualServiceCount={manualServiceCount}
          onRemoveManualService={handleRemoveManualService}
          onAddServiceClick={() => {
            setShowConfigDialog(false);
            setShowAddServiceDialog(true);
          }}
          onApplyChanges={() => {
            setShowConfigDialog(false);
            window.location.reload();
          }}
          onRegisterRepo={async (url: string) => {
            try {
              const res = await fetchApi.fetch(
                '/api/function-analytics/microservice/detect',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ repoUrl: url }),
                },
              );
              if (!res.ok) {
                throw new Error(
                  `Failed to register repository: ${res.statusText}`,
                );
              }
              window.location.reload();
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('Registration failed:', err);
              setError('Failed to register repository');
              setShowConfigDialog(false);
            }
          }}
        />

        <AddServiceDialog
          open={showAddServiceDialog}
          onClose={() => setShowAddServiceDialog(false)}
          onAddService={handleAddManualService}
          selectedBackend={selectedBackend}
        />
      </Content>
    </Page>
  );
};
