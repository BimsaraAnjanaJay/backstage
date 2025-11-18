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

import { useState, useEffect } from 'react';
import {
  Page,
  Header,
  HeaderLabel,
  Content,
  ContentHeader,
  Progress,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
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
  Grid,
  Button,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
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
import { getCatalogInstrumentedServices, getDefaultTracingBackends } from './catalogService';
import { fetchHybridServiceMetrics } from './dataFetcher';
import { analyzeMicroserviceArchitecture, analyzeFunctionPlacement } from './analysisEngine';
import { useStyles } from './styles';

// Import components
import { TabPanel } from './components/TabPanel';
import { ServiceDiscoveryStatus } from './components/ServiceDiscoveryStatus';
import { ConfigurationDialog } from './components/ConfigurationDialog';
import { AddServiceDialog } from './components/AddServiceDialog';

/**
 * Helper function to determine row class based on risk level
 */
const getRowClassName = (
  securityRisk: 'HIGH' | 'MEDIUM' | 'LOW',
  shouldRelocate: boolean,
  classes: any
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
  securityRisk: 'HIGH' | 'MEDIUM' | 'LOW'
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
  const catalogApi = useApi(catalogApiRef);
  const fetchApi = useApi(fetchApiRef);
  
  // Plugin configuration state
  const [pluginMode, setPluginMode] = useState<PluginMode>({
    mode: 'hybrid',
    description: 'Auto-discover from catalog + manual configuration',
  });
  
  // Service configuration state
  const [catalogServices, setCatalogServices] = useState<CatalogServiceConfig[]>([]);
  const [manualServices, setManualServices] = useState<ManualServiceConfig[]>([]);
  const [tracingBackends, setTracingBackends] = useState<TracingBackendConfig[]>(getDefaultTracingBackends());
  const [selectedBackend, setSelectedBackend] = useState<TracingBackendConfig>(getDefaultTracingBackends()[0]);
  
  // Data state
  const [hybridConfigs, setHybridConfigs] = useState<HybridServiceConfig[]>([]);
  const [selectedService, setSelectedService] = useState<string>('all');
  const [timeRange, setTimeRange] = useState('1h');
  const [tabValue, setTabValue] = useState(0);
  
  // Loading and error states
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // UI state
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showAddServiceDialog, setShowAddServiceDialog] = useState(false);

  // Initialize plugin - detect best mode
  useEffect(() => {
    const initializePlugin = async () => {
      setConfigLoading(true);
      try {
        const catalogSvcs = await getCatalogInstrumentedServices(catalogApi);
        setCatalogServices(catalogSvcs);
        
        const savedManualServices = localStorage.getItem('function-analytics-manual-services');
        if (savedManualServices) {
          setManualServices(JSON.parse(savedManualServices));
        }
        
        const savedBackends = localStorage.getItem('function-analytics-backends');
        if (savedBackends) {
          const backends = JSON.parse(savedBackends);
          setTracingBackends(backends);
          const activeBackend = backends.find((b: TracingBackendConfig) => b.enabled);
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
            description: 'No catalog services found - manual configuration required',
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
        const configs = await fetchHybridServiceMetrics(
          catalogServices,
          manualServices,
          selectedBackend,
          fetchApi
        );
        
        setHybridConfigs(configs);
        
        if (configs.length === 0) {
          setError('No services configured or no trace data available. Check Jaeger connection and service instrumentation.');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error fetching hybrid metrics:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch metrics');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [catalogServices, manualServices, selectedBackend, timeRange, configLoading, fetchApi]);

  // Save manual services to localStorage
  useEffect(() => {
    localStorage.setItem('function-analytics-manual-services', JSON.stringify(manualServices));
  }, [manualServices]);

  // Save backends to localStorage
  useEffect(() => {
    localStorage.setItem('function-analytics-backends', JSON.stringify(tracingBackends));
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

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const configs = await fetchHybridServiceMetrics(
        catalogServices,
        manualServices,
        selectedBackend,
        fetchApi
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
  };

  const handleTestJaeger = async () => {
    // eslint-disable-next-line no-console
    console.log('🔍 Testing Jaeger connection...');
    try {
      const response = await fetchApi.fetch('/api/proxy/jaeger/api/services');
      const data = await response.json();
      // eslint-disable-next-line no-console
      console.log('✅ Jaeger services:', data);
      // eslint-disable-next-line no-alert
      alert(`Jaeger connection successful! Found ${data.data?.length || 0} services.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('❌ Jaeger connection failed:', err);
      // eslint-disable-next-line no-alert
      alert('Jaeger connection failed. Check if Jaeger is running on localhost:16686');
    }
  };

  // Aggregate data for display
  const allServices = hybridConfigs;
  const filteredFunctions: FunctionCall[] = allServices
    .filter(service => selectedService === 'all' || service.serviceName === selectedService)
    .flatMap(service => service.functions);

  const totalCalls = allServices.reduce((sum, service) => sum + service.totalCalls, 0);
  const avgLatency = allServices.length > 0 
    ? allServices.reduce((sum, service) => sum + service.avgLatency, 0) / allServices.length 
    : 0;
  const criticalFunctions = filteredFunctions.filter(func => func.errorRate > 1 || func.latency > 100);
  const catalogServiceCount = allServices.filter(s => s.source === 'catalog').length;
  const manualServiceCount = allServices.filter(s => s.source === 'manual').length;
  const placementAnalysis = analyzeFunctionPlacement(filteredFunctions);
  const misplacedFunctions = placementAnalysis.filter(analysis => analysis.shouldRelocate);

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
        <HeaderLabel label="Last Updated" value={new Date().toLocaleTimeString()} />
      </Header>
      
      <Content>
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
            <FormControl variant="outlined" size="small" style={{ minWidth: 120 }}>
              <InputLabel>Service</InputLabel>
              <Select
                value={selectedService}
                onChange={(e) => setSelectedService(e.target.value as string)}
                label="Service"
              >
                <MenuItem value="all">All Services</MenuItem>
                {allServices.map(service => (
                  <MenuItem key={service.serviceName} value={service.serviceName}>
                    <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                      {service.source === 'catalog' ? <CloudQueueIcon fontSize="small" /> : <StorageIcon fontSize="small" />}
                      {service.serviceName}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            
            <FormControl variant="outlined" size="small" style={{ minWidth: 100 }}>
              <InputLabel>Time Range</InputLabel>
              <Select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as string)}
                label="Time Range"
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

        <Grid container spacing={3} style={{ marginBottom: '24px' }}>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.card}>
              <CardContent className={classes.metric}>
                <Typography variant="h6" color="textSecondary">
                  Total Function Calls
                </Typography>
                <Typography className={classes.metricValue}>
                  {totalCalls.toLocaleString()}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.card}>
              <CardContent className={classes.metric}>
                <Typography variant="h6" color="textSecondary">
                  Average Latency
                </Typography>
                <Typography className={classes.metricValue}>
                  {avgLatency.toFixed(1)}ms
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.card}>
              <CardContent className={classes.metric}>
                <Typography variant="h6" color="textSecondary">
                  Critical Functions
                </Typography>
                <Typography className={classes.metricValue} style={{ color: '#f44336' }}>
                  {criticalFunctions.length}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.card}>
              <CardContent className={classes.metric}>
                <Typography variant="h6" color="textSecondary">
                  Misplaced Functions
                </Typography>
                <Typography className={classes.metricValue} style={{ color: '#ff9800' }}>
                  {misplacedFunctions.length}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <Paper>
          <Tabs value={tabValue} onChange={handleTabChange} indicatorColor="primary" textColor="primary">
            <Tab label="Function Details" />
            <Tab label="Service Overview" />
            <Tab label="Microservice Architecture" />
            <Tab label="Configuration" />
            <Tab label="Function Placement Analysis" />
          </Tabs>
          
          {/* Tab 0: Function Details */}
          <TabPanel value={tabValue} index={0}>
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
                      const service = allServices.find(s => s.serviceName === func.serviceName);
                      return (
                        <TableRow 
                          key={index}
                          className={service?.source === 'catalog' ? classes.catalogService : classes.manualService}
                        >
                          <TableCell>{func.functionName}</TableCell>
                          <TableCell>{func.serviceName}</TableCell>
                          <TableCell>
                            <Chip 
                              icon={service?.source === 'catalog' ? <CloudQueueIcon /> : <StorageIcon />}
                              label={service?.source || 'unknown'} 
                              size="small"
                              className={classes.serviceSourceChip}
                              color={service?.source === 'catalog' ? 'primary' : 'secondary'}
                            />
                          </TableCell>
                          <TableCell>
                            <Chip 
                              label={func.type} 
                              color={func.type === 'external' ? 'secondary' : 'primary'} 
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
                            ) : '-'}
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
                      <TableCell colSpan={10} style={{ textAlign: 'center', padding: '40px' }}>
                        <Typography color="textSecondary">
                          No function data available. Configure services to start analyzing traces.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>

          {/* Tab 1: Service Overview */}
          <TabPanel value={tabValue} index={1}>
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
                  {allServices.map((service, index) => (
                    <TableRow 
                      key={index}
                      className={service.source === 'catalog' ? classes.catalogService : classes.manualService}
                    >
                      <TableCell>{service.serviceName}</TableCell>
                      <TableCell>
                        <Chip 
                          icon={service.source === 'catalog' ? <CloudQueueIcon /> : <StorageIcon />}
                          label={service.source} 
                          size="small"
                          color={service.source === 'catalog' ? 'primary' : 'secondary'}
                        />
                      </TableCell>
                      <TableCell>{service.owner || 'Unknown'}</TableCell>
                      <TableCell>{service.environment || 'Unknown'}</TableCell>
                      <TableCell>
                        <Chip 
                          icon={service.connectionStatus === 'connected' ? <CheckCircleIcon /> : <CancelIcon />}
                          label={service.connectionStatus} 
                          size="small"
                          color={service.connectionStatus === 'connected' ? 'primary' : 'default'}
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

          {/* Tab 2: Microservice Architecture */}
          <TabPanel value={tabValue} index={2}>
            <Typography variant="h6" gutterBottom>
              Microservice Architecture Analysis
            </Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Analyze microservice dependencies, critical paths, and architectural patterns.
            </Typography>
            
            {(() => {
              const architecture = analyzeMicroserviceArchitecture(allServices);
              const serviceList = Array.from(architecture.serviceMap.entries());
              
              return (
                <Grid container spacing={3}>
                  <Grid item xs={12} md={6}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Service Dependencies
                        </Typography>
                        {serviceList.length > 0 ? (
                          <List dense>
                            {serviceList.map(([service, deps]) => (
                              <ListItem key={service}>
                                <ListItemIcon>
                                  <CloudQueueIcon color="primary" />
                                </ListItemIcon>
                                <ListItemText
                                  primary={service}
                                  secondary={`Dependencies: ${deps.length > 0 ? deps.join(', ') : 'None'}`}
                                />
                              </ListItem>
                            ))}
                          </List>
                        ) : (
                          <Typography color="textSecondary">No service dependencies found</Typography>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  
                  <Grid item xs={12} md={6}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Critical Paths
                        </Typography>
                        {architecture.criticalPaths.length > 0 ? (
                          <List dense>
                            {architecture.criticalPaths.map((path, index) => (
                              <ListItem key={index}>
                                <ListItemIcon>
                                  <CancelIcon color="secondary" />
                                </ListItemIcon>
                                <ListItemText
                                  primary={`Path ${index + 1}`}
                                  secondary={path.join(' → ')}
                                />
                              </ListItem>
                            ))}
                          </List>
                        ) : (
                          <Typography color="textSecondary">No critical paths identified</Typography>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  
                  <Grid item xs={12} md={6}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Performance Bottlenecks
                        </Typography>
                        {architecture.bottlenecks.length > 0 ? (
                          <List dense>
                            {architecture.bottlenecks.map((bottleneck, index) => (
                              <ListItem key={index}>
                                <ListItemIcon>
                                  <CancelIcon color="error" />
                                </ListItemIcon>
                                <ListItemText
                                  primary={bottleneck}
                                  secondary="High latency or error rate detected"
                                />
                              </ListItem>
                            ))}
                          </List>
                        ) : (
                          <Typography color="textSecondary">No bottlenecks identified</Typography>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  
                  <Grid item xs={12} md={6}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Microservice Types
                        </Typography>
                        <List dense>
                          {allServices.map((service, index) => {
                            const typeCounts = service.functions.reduce((acc, func) => {
                              acc[func.microserviceType || 'service'] = (acc[func.microserviceType || 'service'] || 0) + 1;
                              return acc;
                            }, {} as Record<string, number>);
                            
                            return (
                              <ListItem key={index}>
                                <ListItemIcon>
                                  <CloudQueueIcon color="primary" />
                                </ListItemIcon>
                                <ListItemText
                                  primary={service.serviceName}
                                  secondary={Object.entries(typeCounts)
                                    .map(([type, count]) => `${type}: ${count}`)
                                    .join(', ')}
                                />
                              </ListItem>
                            );
                          })}
                        </List>
                      </CardContent>
                    </Card>
                  </Grid>
                </Grid>
              );
            })()}
          </TabPanel>

          {/* Tab 3: Configuration */}
          <TabPanel value={tabValue} index={3}>
            <Typography variant="h6" gutterBottom>
              Hybrid Configuration Management
            </Typography>
            
            <Grid container spacing={3}>
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Catalog Services ({catalogServiceCount})
                    </Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      Services auto-discovered from Backstage catalog with tracing annotations.
                    </Typography>
                    {catalogServices.length > 0 ? (
                      <List dense>
                        {catalogServices.map((service, index) => (
                          <ListItem key={index}>
                            <ListItemIcon>
                              <CloudQueueIcon color="primary" />
                            </ListItemIcon>
                            <ListItemText
                              primary={service.serviceName}
                              secondary={`Owner: ${service.owner || 'Unknown'} • ${service.environment}`}
                            />
                          </ListItem>
                        ))}
                      </List>
                    ) : (
                      <Alert severity="info">
                        No catalog services found. Add tracing annotations to your catalog entities.
                      </Alert>
                    )}
                  </CardContent>
                </Card>
              </Grid>

              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Manual Services ({manualServiceCount})
                    </Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      Services manually configured for analysis.
                    </Typography>
                    {manualServices.length > 0 ? (
                      <List dense>
                        {manualServices.map((service) => (
                          <ListItem key={service.id}>
                            <ListItemIcon>
                              <StorageIcon color="secondary" />
                            </ListItemIcon>
                            <ListItemText
                              primary={service.displayName}
                              secondary={`${service.tracingBackend.name} • ${service.environment}`}
                            />
                          </ListItem>
                        ))}
                      </List>
                    ) : (
                      <Alert severity="info">
                        No manual services configured.
                        <Button
                          size="small"
                          onClick={() => setShowAddServiceDialog(true)}
                          style={{ marginLeft: 8 }}
                        >
                          Add Service
                        </Button>
                      </Alert>
                    )}
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          </TabPanel>

          {/* Tab 4: Function Placement Analysis */}
          <TabPanel value={tabValue} index={4}>
            <Typography variant="h6" gutterBottom>
              Function Placement Analysis - Identify Misplaced Functions
            </Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Functions with high external call percentages (&gt;70%) may be misplaced and should be relocated to optimize performance and reduce cross-service latency.
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
                  {placementAnalysis.length > 0 ? (
                    placementAnalysis.map((analysis, index) => {
                      const service = allServices.find(s => s.serviceName === analysis.serviceName);
                      return (
                        <TableRow 
                          key={index}
                          className={getRowClassName(
                            analysis.securityRisk,
                            analysis.shouldRelocate,
                            classes
                          )}
                        >
                          <TableCell>{analysis.functionName}</TableCell>
                          <TableCell>{analysis.serviceName}</TableCell>
                          <TableCell>
                            <Chip 
                              icon={service?.source === 'catalog' ? <CloudQueueIcon /> : <StorageIcon />}
                              label={service?.source || 'unknown'} 
                              size="small"
                              className={classes.serviceSourceChip}
                            />
                          </TableCell>
                          <TableCell>{analysis.internalCallPercentage.toFixed(1)}%</TableCell>
                          <TableCell>{analysis.externalCallPercentage.toFixed(1)}%</TableCell>
                          <TableCell>
                            <Chip 
                              label={analysis.securityRisk} 
                              color={getChipColor(analysis.securityRisk)}
                              size="small"
                            />
                          </TableCell>
                          <TableCell>{analysis.relocateReason}</TableCell>
                          <TableCell>{analysis.suggestedTargetService || 'N/A'}</TableCell>
                          <TableCell>{analysis.latencyImpact.toFixed(1)}</TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={9} style={{ textAlign: 'center', padding: '40px' }}>
                        <Typography color="textSecondary">
                          No function placement data available for analysis.
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
