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

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Page, Header, HeaderLabel, Content } from '@backstage/core-components';
import {
  useApi,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import {
  Button,
  TextField,
  Typography,
  Box,
  Grid,
  Card,
  CardContent,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  LinearProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
  Stepper,
  Step,
  StepLabel,
  Checkbox,
  FormControlLabel,
  CircularProgress,
  IconButton,
  TableSortLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@material-ui/core';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import SettingsIcon from '@material-ui/icons/Settings';
import {
  FunctionAnalyticsClient,
  RelocationResult,
  DiscoveredService,
  JobStatus,
} from '../../api/FunctionAnalyticsClient';
import { generateExplanation } from './explanations';

const pipelineSteps = [
  'Cloning',
  'Detecting',
  'Deploying',
  'Tracing',
  'Analyzing',
];
const statusToStepIndex: Record<string, number> = {
  cloning: 0,
  detecting: 1,
  deploying: 2,
  tracing: 3,
  analyzing: 4,
  done: 5,
  error: -1,
};

const getLanguageColor = (lang: string): string => {
  const colors: Record<string, string> = {
    nodejs: '#68a063',
    typescript: '#3178c6',
    javascript: '#f7df1e',
    python: '#3776ab',
    java: '#f89820',
    go: '#00add8',
    ruby: '#cc342d',
    dotnet: '#512bd4',
    rust: '#dea584',
  };
  return colors[lang.toLowerCase()] || '#757575';
};

const getRecommendationBadge = (
  rec: string,
  suggestedService: string | null,
) => {
  switch (rec) {
    case 'relocate':
      return {
        label: `Relocate \u2192 ${suggestedService || '?'}`,
        color: '#d32f2f',
        bg: '#ffebee',
      };
    case 'review':
      return { label: 'Review', color: '#f57c00', bg: '#fff3e0' };
    case 'extract':
      return { label: 'Extract (Shared)', color: '#1565c0', bg: '#e3f2fd' };
    default:
      return { label: 'Well Placed', color: '#2e7d32', bg: '#e8f5e9' };
  }
};

const getRiskColor = (risk: string): string => {
  switch (risk) {
    case 'HIGH':
      return '#d32f2f';
    case 'MEDIUM':
      return '#f57c00';
    case 'LOW':
      return '#fbc02d';
    default:
      return '#4caf50';
  }
};

export const FunctionAnalyticsPage = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const client = useMemo(
    () => new FunctionAnalyticsClient({ discoveryApi, fetchApi }),
    [discoveryApi, fetchApi],
  );

  // Wizard step
  const [activeStep, setActiveStep] = useState(0);

  // Step 1
  const [repoUrl, setRepoUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [repoName, setRepoName] = useState('');

  // Step 2
  const [services, setServices] = useState<DiscoveredService[]>([]);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(),
  );

  // Step 3
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  // Step 4
  const [results, setResults] = useState<RelocationResult[]>([]);
  const [tracingAvailable, setTracingAvailable] = useState<boolean>(true);
  const [sortField, setSortField] = useState<string>('priorityScore');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [filterRecommendation, setFilterRecommendation] =
    useState<string>('all');
  const [filterService, setFilterService] = useState<string>('all');
  const [filterRisk, setFilterRisk] = useState<string>('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Settings
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [externalCallThreshold, setExternalCallThreshold] = useState(0.65);
  const [confidenceMargin, setConfidenceMargin] = useState(0.05);
  const [thresholdInput, setThresholdInput] = useState('65');
  const [marginInput, setMarginInput] = useState('5');

  const [detectProgressMsg, setDetectProgressMsg] = useState<string>('');

  const handleDetectServices = useCallback(async () => {
    setDetecting(true);
    setDetectError(null);
    setDetectProgressMsg('');
    try {
      const result = await client.detectServices(repoUrl, msg =>
        setDetectProgressMsg(msg),
      );
      setRepoName(result.repoName);
      setServices(result.services);
      setSelectedServices(new Set(result.services.map(s => s.name)));
      setActiveStep(1);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetecting(false);
      setDetectProgressMsg('');
    }
  }, [client, repoUrl]);

  const handleStartAnalysis = useCallback(async () => {
    try {
      const { jobId: id } = await client.startFullAnalysis(
        repoUrl,
        undefined,
        Array.from(selectedServices),
        externalCallThreshold,
        confidenceMargin,
      );
      setJobId(id);
      setActiveStep(2);
    } catch (err) {
      setDetectError(
        err instanceof Error ? err.message : 'Failed to start analysis',
      );
    }
  }, [
    client,
    repoUrl,
    selectedServices,
    externalCallThreshold,
    confidenceMargin,
  ]);

  // Poll job status
  useEffect(() => {
    if (!jobId || activeStep !== 2) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await client.getJobStatus(jobId);
        if (cancelled) return;
        setJobStatus(status);
        if (status.status === 'done' && status.result) {
          setResults(status.result.results);
          setServices(status.result.services);
          setTracingAvailable(status.result.tracingAvailable !== false);
          setActiveStep(3);
        } else if (status.status === 'error') {
          // stay on step 2 showing error
        } else {
          setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 3000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId, activeStep, client]);

  const filteredAndSortedResults = useMemo(() => {
    let filtered = results;
    if (filterRecommendation !== 'all') {
      filtered = filtered.filter(
        r => r.recommendation === filterRecommendation,
      );
    }
    if (filterService !== 'all') {
      filtered = filtered.filter(r => r.currentService === filterService);
    }
    if (filterRisk !== 'all') {
      filtered = filtered.filter(r => r.riskLevel === filterRisk);
    }
    const sorted = [...filtered].sort((a, b) => {
      let aVal: any = (a as any)[sortField];
      let bVal: any = (b as any)[sortField];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [
    results,
    filterRecommendation,
    filterService,
    filterRisk,
    sortField,
    sortDirection,
  ]);

  const tableColumns = [
    { id: 'functionName', label: 'Function Name' },
    { id: 'currentService', label: 'Current Service' },
    { id: 'codeLocation', label: 'File Location' },
    { id: 'riskLevel', label: 'Risk' },
    { id: 'recommendation', label: 'Recommendation' },
    { id: 'suggestedService', label: 'Suggested Target' },
    { id: 'confidence', label: 'Confidence' },
    { id: 'predictedLatencyImprovement', label: 'Latency Impact' },
    { id: 'priorityScore', label: 'Priority Score' },
  ];

  return (
    <Page themeId="tool">
      <Header
        title="Function Relocation Analytics"
        subtitle="Detect misplaced functions in microservice architectures"
      >
        <HeaderLabel label="Mode" value="Automated" />
        <HeaderLabel
          label="Threshold"
          value={`${Math.round(externalCallThreshold * 100)}%`}
        />
        <HeaderLabel
          label="Margin"
          value={`${Math.round(confidenceMargin * 100)}%`}
        />
        <Tooltip title="Analysis Settings">
          <IconButton
            color="inherit"
            onClick={() => {
              setThresholdInput(
                String(Math.round(externalCallThreshold * 100)),
              );
              setMarginInput(String(Math.round(confidenceMargin * 100)));
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Header>
      <Content>
        {/* Top-level stepper showing 4 wizard steps */}
        <Stepper activeStep={activeStep} style={{ marginBottom: 24 }}>
          <Step>
            <StepLabel>Repository Input</StepLabel>
          </Step>
          <Step>
            <StepLabel>Service Selection</StepLabel>
          </Step>
          <Step>
            <StepLabel>Analysis in Progress</StepLabel>
          </Step>
          <Step>
            <StepLabel>Results</StepLabel>
          </Step>
        </Stepper>

        {/* Step 0: Repo Input */}
        {activeStep === 0 && (
          <Card>
            <CardContent>
              <Typography variant="h5" gutterBottom>
                Analyze a Microservice Repository
              </Typography>
              <Typography variant="body2" color="textSecondary" gutterBottom>
                Paste a GitHub repository URL containing microservices. The
                plugin will automatically detect services, deploy them, collect
                traces, and identify misplaced functions.
              </Typography>
              <Box
                display="flex"
                alignItems="center"
                mt={3}
                style={{ gap: 16 }}
              >
                <TextField
                  label="GitHub Repository URL"
                  placeholder="https://github.com/org/microservices-repo"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  variant="outlined"
                  fullWidth
                  disabled={detecting}
                />
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleDetectServices}
                  disabled={detecting || !repoUrl.trim()}
                  style={{ minWidth: 180, height: 56 }}
                >
                  {detecting ? (
                    <CircularProgress size={24} />
                  ) : (
                    'Detect Services'
                  )}
                </Button>
              </Box>
              {detecting && detectProgressMsg && (
                <Box mt={2}>
                  <Typography color="textSecondary" variant="body2">
                    {detectProgressMsg}
                  </Typography>
                </Box>
              )}
              {detectError && (
                <Box mt={2}>
                  <Typography color="error">{detectError}</Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 1: Service Selection */}
        {activeStep === 1 && (
          <Box>
            <Card style={{ marginBottom: 16 }}>
              <CardContent>
                <Box
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <Box>
                    <Typography variant="h5" gutterBottom>
                      Detected Services
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Found {services.length} services in {repoName}. Select the
                      services to include in the analysis.
                    </Typography>
                  </Box>
                  <Box display="flex" style={{ gap: 8 }}>
                    <Button variant="outlined" onClick={() => setActiveStep(0)}>
                      Back
                    </Button>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={selectedServices.size === services.length}
                          onChange={e => {
                            if (e.target.checked) {
                              setSelectedServices(
                                new Set(services.map(s => s.name)),
                              );
                            } else {
                              setSelectedServices(new Set());
                            }
                          }}
                        />
                      }
                      label="Select All"
                    />
                  </Box>
                </Box>
                {selectedServices.size < 2 && (
                  <Box mt={1}>
                    <Typography variant="body2" style={{ color: '#f57c00' }}>
                      Select at least 2 services for meaningful cross-service
                      analysis.
                    </Typography>
                  </Box>
                )}
              </CardContent>
            </Card>

            <Grid container spacing={2}>
              {services.map(svc => (
                <Grid item xs={12} sm={6} md={4} key={svc.name}>
                  <Card
                    style={{
                      border: selectedServices.has(svc.name)
                        ? '2px solid #1976d2'
                        : '1px solid #e0e0e0',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      const next = new Set(selectedServices);
                      if (next.has(svc.name)) next.delete(svc.name);
                      else next.add(svc.name);
                      setSelectedServices(next);
                    }}
                  >
                    <CardContent>
                      <Box
                        display="flex"
                        justifyContent="space-between"
                        alignItems="center"
                      >
                        <Typography variant="h6">{svc.name}</Typography>
                        <Checkbox
                          checked={selectedServices.has(svc.name)}
                          color="primary"
                        />
                      </Box>
                      <Box display="flex" style={{ gap: 8 }} mt={1}>
                        <Chip
                          label={svc.language.toUpperCase()}
                          size="small"
                          style={{
                            backgroundColor: getLanguageColor(svc.language),
                            color: '#fff',
                          }}
                        />
                        {svc.port > 0 && (
                          <Chip
                            label={`Port ${svc.port}`}
                            size="small"
                            variant="outlined"
                          />
                        )}
                        {svc.hasDockerfile && (
                          <Chip
                            label="Dockerfile"
                            size="small"
                            variant="outlined"
                            color="primary"
                          />
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        color="textSecondary"
                        style={{ marginTop: 8, display: 'block' }}
                      >
                        {svc.path}
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>

            <Box mt={3} display="flex" justifyContent="center">
              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={handleStartAnalysis}
                disabled={selectedServices.size < 2}
                style={{ minWidth: 240 }}
              >
                Start Full Analysis
              </Button>
            </Box>
          </Box>
        )}

        {/* Step 2: Progress */}
        {activeStep === 2 && (
          <Card>
            <CardContent>
              <Typography variant="h5" gutterBottom>
                Analysis in Progress
              </Typography>
              <Box mt={2} mb={3}>
                <Stepper
                  activeStep={
                    jobStatus ? statusToStepIndex[jobStatus.status] ?? 0 : 0
                  }
                  alternativeLabel
                >
                  {pipelineSteps.map(label => (
                    <Step key={label}>
                      <StepLabel>{label}</StepLabel>
                    </Step>
                  ))}
                </Stepper>
              </Box>
              <Box mb={2}>
                <LinearProgress
                  variant="determinate"
                  value={jobStatus?.progress || 0}
                  style={{ height: 8, borderRadius: 4 }}
                />
                <Box display="flex" justifyContent="space-between" mt={1}>
                  <Typography variant="body2" color="textSecondary">
                    {jobStatus?.currentStep || 'Initializing...'}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {jobStatus?.progress || 0}%
                  </Typography>
                </Box>
              </Box>
              {jobStatus?.status === 'error' && (
                <Box
                  mt={2}
                  p={2}
                  style={{ backgroundColor: '#ffebee', borderRadius: 4 }}
                >
                  <Typography color="error" variant="body1">
                    Error: {jobStatus.error}
                  </Typography>
                  <Button
                    variant="outlined"
                    onClick={() => setActiveStep(0)}
                    style={{ marginTop: 8 }}
                  >
                    Try Again
                  </Button>
                </Box>
              )}
              <Paper
                variant="outlined"
                style={{
                  maxHeight: 300,
                  overflow: 'auto',
                  padding: 16,
                  backgroundColor: '#1e1e1e',
                  marginTop: 16,
                }}
              >
                {(jobStatus?.logs || []).map((log, i) => (
                  <Typography
                    key={i}
                    variant="body2"
                    style={{
                      fontFamily: 'monospace',
                      color: '#d4d4d4',
                      fontSize: '0.8rem',
                    }}
                  >
                    {log}
                  </Typography>
                ))}
                {(!jobStatus?.logs || jobStatus.logs.length === 0) && (
                  <Typography
                    variant="body2"
                    style={{ fontFamily: 'monospace', color: '#666' }}
                  >
                    Waiting for logs...
                  </Typography>
                )}
              </Paper>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Results */}
        {activeStep === 3 && (
          <Box>
            {/* Summary Cards */}
            <Grid container spacing={2} style={{ marginBottom: 24 }}>
              <Grid item xs={12} sm={4}>
                <Card>
                  <CardContent style={{ textAlign: 'center' }}>
                    <Typography variant="h3" color="primary">
                      {results.length}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Functions analyzed across{' '}
                      {new Set(results.map(r => r.currentService)).size}{' '}
                      services
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card>
                  <CardContent style={{ textAlign: 'center' }}>
                    <Typography variant="h3" style={{ color: '#d32f2f' }}>
                      {results.filter(r => r.recommendation !== 'keep').length}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Functions need attention
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card>
                  <CardContent style={{ textAlign: 'center' }}>
                    <Typography variant="h3" style={{ color: '#2e7d32' }}>
                      {Math.round(
                        results
                          .filter(r => r.recommendation === 'relocate')
                          .reduce(
                            (s, r) => s + r.predictedLatencyImprovement,
                            0,
                          ),
                      )}
                      ms
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Estimated latency savings
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {/* Filter Bar */}
            <Paper style={{ padding: 16, marginBottom: 16 }}>
              <Box display="flex" style={{ gap: 16 }} alignItems="center">
                <FormControl
                  variant="outlined"
                  size="small"
                  style={{ minWidth: 160 }}
                >
                  <InputLabel>Recommendation</InputLabel>
                  <Select
                    value={filterRecommendation}
                    onChange={e =>
                      setFilterRecommendation(e.target.value as string)
                    }
                    label="Recommendation"
                  >
                    <MenuItem value="all">All</MenuItem>
                    <MenuItem value="relocate">Relocate</MenuItem>
                    <MenuItem value="review">Review</MenuItem>
                    <MenuItem value="extract">Extract</MenuItem>
                    <MenuItem value="keep">Well Placed</MenuItem>
                  </Select>
                </FormControl>
                <FormControl
                  variant="outlined"
                  size="small"
                  style={{ minWidth: 160 }}
                >
                  <InputLabel>Service</InputLabel>
                  <Select
                    value={filterService}
                    onChange={e => setFilterService(e.target.value as string)}
                    label="Service"
                  >
                    <MenuItem value="all">All Services</MenuItem>
                    {Array.from(new Set(results.map(r => r.currentService)))
                      .sort()
                      .map(s => (
                        <MenuItem key={s} value={s}>
                          {s}
                        </MenuItem>
                      ))}
                  </Select>
                </FormControl>
                <FormControl
                  variant="outlined"
                  size="small"
                  style={{ minWidth: 120 }}
                >
                  <InputLabel>Risk</InputLabel>
                  <Select
                    value={filterRisk}
                    onChange={e => setFilterRisk(e.target.value as string)}
                    label="Risk"
                  >
                    <MenuItem value="all">All</MenuItem>
                    <MenuItem value="HIGH">High</MenuItem>
                    <MenuItem value="MEDIUM">Medium</MenuItem>
                    <MenuItem value="LOW">Low</MenuItem>
                    <MenuItem value="NONE">None</MenuItem>
                  </Select>
                </FormControl>
                <Typography
                  variant="body2"
                  color="textSecondary"
                  style={{ marginLeft: 'auto' }}
                >
                  Showing {filteredAndSortedResults.length} of {results.length}{' '}
                  functions
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setActiveStep(0)}
                >
                  New Analysis
                </Button>
              </Box>
            </Paper>

            {/* Results Table */}
            <TableContainer component={Paper}>
              <Table size="small">
                <TableHead>
                  <TableRow style={{ backgroundColor: '#1976d2' }}>
                    <TableCell
                      style={{ color: '#fff', fontWeight: 'bold', width: 40 }}
                    />
                    {tableColumns.map(col => (
                      <TableCell
                        key={col.id}
                        style={{
                          color: '#fff',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                        onClick={() => {
                          if (sortField === col.id) {
                            setSortDirection(d =>
                              d === 'asc' ? 'desc' : 'asc',
                            );
                          } else {
                            setSortField(col.id);
                            setSortDirection('desc');
                          }
                        }}
                      >
                        <TableSortLabel
                          active={sortField === col.id}
                          direction={
                            sortField === col.id ? sortDirection : 'asc'
                          }
                          style={{ color: '#fff' }}
                        >
                          {col.label}
                        </TableSortLabel>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredAndSortedResults.map((result, index) => {
                    const badge = getRecommendationBadge(
                      result.recommendation,
                      result.suggestedService,
                    );
                    const confidencePct = Math.round(result.confidence * 100);
                    const isExpanded = expandedRow === index;

                    return (
                      <React.Fragment key={index}>
                        <TableRow
                          hover
                          style={{ cursor: 'pointer' }}
                          onClick={() =>
                            setExpandedRow(isExpanded ? null : index)
                          }
                        >
                          <TableCell>
                            <IconButton size="small">
                              <ExpandMoreIcon
                                style={{
                                  transform: isExpanded
                                    ? 'rotate(180deg)'
                                    : 'none',
                                  transition: '0.2s',
                                }}
                              />
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Typography
                              variant="body2"
                              style={{ fontWeight: 500 }}
                            >
                              {result.functionName}
                            </Typography>
                          </TableCell>
                          <TableCell>{result.currentService}</TableCell>
                          <TableCell>
                            <Typography variant="caption" color="textSecondary">
                              {result.codeLocation?.displayPath || '\u2014'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={result.riskLevel}
                              size="small"
                              style={{
                                backgroundColor: getRiskColor(result.riskLevel),
                                color: '#fff',
                                fontWeight: 'bold',
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={badge.label}
                              size="small"
                              style={{
                                backgroundColor: badge.bg,
                                color: badge.color,
                                fontWeight: 500,
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            {result.suggestedService ||
                              (result.recommendation === 'extract'
                                ? '(shared service)'
                                : '\u2014')}
                          </TableCell>
                          <TableCell>
                            <Box
                              display="flex"
                              alignItems="center"
                              style={{ gap: 4 }}
                            >
                              <LinearProgress
                                variant="determinate"
                                value={confidencePct}
                                style={{
                                  width: 60,
                                  height: 6,
                                  borderRadius: 3,
                                }}
                              />
                              <Typography
                                variant="caption"
                                color={
                                  confidencePct < 50 ? 'error' : 'textSecondary'
                                }
                              >
                                {confidencePct}%
                              </Typography>
                            </Box>
                          </TableCell>
                          <TableCell>
                            {result.predictedLatencyImprovement > 0
                              ? `${result.predictedLatencyImprovement.toFixed(
                                  1,
                                )}ms`
                              : '\u2014'}
                          </TableCell>
                          <TableCell>
                            <Tooltip
                              title={`Priority: ${(
                                result.priorityScore * 100
                              ).toFixed(0)}%`}
                            >
                              <Typography
                                variant="body2"
                                style={{ fontWeight: 'bold' }}
                              >
                                {result.priorityScore.toFixed(3)}
                              </Typography>
                            </Tooltip>
                          </TableCell>
                        </TableRow>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <TableRow>
                            <TableCell
                              colSpan={10}
                              style={{
                                backgroundColor: '#fafafa',
                                padding: 24,
                              }}
                            >
                              <Grid container spacing={3}>
                                <Grid item xs={12} md={6}>
                                  <Typography variant="subtitle2" gutterBottom>
                                    Code Location
                                  </Typography>
                                  {result.codeLocation ? (
                                    <Box>
                                      <Typography variant="body2">
                                        File: {result.codeLocation.file}
                                      </Typography>
                                      {result.codeLocation.className && (
                                        <Typography variant="body2">
                                          Class: {result.codeLocation.className}
                                        </Typography>
                                      )}
                                      {result.codeLocation.lineStart && (
                                        <Typography variant="body2">
                                          Line: {result.codeLocation.lineStart}
                                        </Typography>
                                      )}
                                    </Box>
                                  ) : (
                                    <Typography
                                      variant="body2"
                                      color="textSecondary"
                                    >
                                      Not available
                                    </Typography>
                                  )}

                                  <Box mt={2}>
                                    <Typography
                                      variant="subtitle2"
                                      gutterBottom
                                    >
                                      Call Breakdown
                                    </Typography>
                                    <Box
                                      display="flex"
                                      alignItems="center"
                                      style={{ gap: 8 }}
                                    >
                                      <Box
                                        style={{
                                          flex: result.internalCalls,
                                          backgroundColor: '#4caf50',
                                          height: 24,
                                          borderRadius: 4,
                                          minWidth: 4,
                                        }}
                                      />
                                      <Box
                                        style={{
                                          flex: result.externalCalls,
                                          backgroundColor: '#f44336',
                                          height: 24,
                                          borderRadius: 4,
                                          minWidth: 4,
                                        }}
                                      />
                                    </Box>
                                    <Box
                                      display="flex"
                                      justifyContent="space-between"
                                      mt={0.5}
                                    >
                                      <Typography variant="caption">
                                        Internal: {result.internalCalls}
                                      </Typography>
                                      <Typography variant="caption">
                                        External: {result.externalCalls}
                                      </Typography>
                                    </Box>
                                  </Box>
                                </Grid>
                                <Grid item xs={12} md={6}>
                                  <Typography variant="subtitle2" gutterBottom>
                                    Metrics
                                  </Typography>
                                  <Typography variant="body2">
                                    Cohesion Delta:{' '}
                                    {result.cohesionDelta > 0 ? '+' : ''}
                                    {result.cohesionDelta.toFixed(3)}
                                  </Typography>
                                  <Typography variant="body2">
                                    Pattern Stability:{' '}
                                    {(result.patternStability * 100).toFixed(0)}
                                    %
                                  </Typography>
                                  <Typography variant="body2">
                                    Static Coverage: {result.staticCoverage}
                                  </Typography>
                                  {result.coLocationGroup &&
                                    result.coLocationGroup.length > 0 && (
                                      <Box mt={1}>
                                        <Typography variant="body2">
                                          Co-located with:{' '}
                                          {result.coLocationGroup.join(', ')}
                                        </Typography>
                                        {result.coLocationAction && (
                                          <Chip
                                            label={result.coLocationAction}
                                            size="small"
                                            variant="outlined"
                                            style={{ marginTop: 4 }}
                                          />
                                        )}
                                      </Box>
                                    )}

                                  <Box
                                    mt={2}
                                    p={2}
                                    style={{
                                      backgroundColor: '#e8f5e9',
                                      borderRadius: 8,
                                      borderLeft: '4px solid #4caf50',
                                    }}
                                  >
                                    <Typography
                                      variant="subtitle2"
                                      gutterBottom
                                    >
                                      Analysis
                                    </Typography>
                                    <Typography variant="body2">
                                      {generateExplanation(result)}
                                    </Typography>
                                  </Box>
                                </Grid>
                              </Grid>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {filteredAndSortedResults.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={10}
                        style={{ textAlign: 'center', padding: 40 }}
                      >
                        <Typography color="textSecondary">
                          {results.length === 0
                            ? 'No analysis results yet. Start by entering a repository URL above.'
                            : 'No results match the current filters.'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
        {/* Settings Dialog */}
        <Dialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle>Analysis Settings</DialogTitle>
          <DialogContent>
            <Box
              mt={1}
              display="flex"
              flexDirection="column"
              style={{ gap: 20 }}
            >
              <TextField
                label="External Call Threshold (%)"
                type="number"
                value={thresholdInput}
                onChange={e => setThresholdInput(e.target.value)}
                helperText="Functions with external ratio ≥ this value are candidates for relocation (0–100, default 65)"
                inputProps={{ step: 1, min: 0, max: 100 }}
                variant="outlined"
                fullWidth
              />
              <TextField
                label="Confidence Margin (%)"
                type="number"
                value={marginInput}
                onChange={e => setMarginInput(e.target.value)}
                helperText="Dominant caller must exceed internal ratio by at least this margin (0–50, default 5)"
                inputProps={{ step: 1, min: 0, max: 50 }}
                variant="outlined"
                fullWidth
              />
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button
              color="primary"
              variant="contained"
              onClick={() => {
                const t = parseFloat(thresholdInput);
                const m = parseFloat(marginInput);
                if (!isNaN(t) && t >= 0 && t <= 100)
                  setExternalCallThreshold(t / 100);
                if (!isNaN(m) && m >= 0 && m <= 50)
                  setConfidenceMargin(m / 100);
                setSettingsOpen(false);
              }}
            >
              Apply
            </Button>
          </DialogActions>
        </Dialog>
      </Content>
    </Page>
  );
};
