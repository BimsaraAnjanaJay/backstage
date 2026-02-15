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

import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  LinearProgress,
  IconButton,
  Collapse,
  Link,
} from '@material-ui/core';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import ExpandLessIcon from '@material-ui/icons/ExpandLess';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { makeStyles } from '@material-ui/core/styles';
import { useApi, fetchApiRef } from '@backstage/core-plugin-api';
import { Alert } from '@material-ui/lab';

const useStyles = makeStyles(theme => ({
  traceRow: {
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
  spanRow: {
    backgroundColor: theme.palette.background.default,
    paddingLeft: theme.spacing(4),
  },
  durationBar: {
    height: 8,
    borderRadius: 4,
    marginTop: theme.spacing(0.5),
  },
  successChip: {
    backgroundColor: theme.palette.success.main,
    color: theme.palette.success.contrastText,
  },
  errorChip: {
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
  },
}));

interface Span {
  spanID: string;
  processID: string;
  operationName: string;
  startTime: number;
  duration: number;
  tags: Array<{ key: string; value: any }>;
  references?: Array<{ refType: string; spanID: string }>;
}

interface Trace {
  traceID: string;
  spans: Span[];
  processes: Record<string, { serviceName: string }>;
}

interface TraceViewerProps {
  serviceName: string;
  timeRange: string;
  repoName?: string;
}

export const TraceViewer = ({ serviceName, timeRange, repoName }: TraceViewerProps) => {
  const classes = useStyles();
  const fetchApi = useApi(fetchApiRef);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [autoStarting, setAutoStarting] = useState(false);

  const fetchAvailableServices = useCallback(async () => {
    try {
      const response = await fetchApi.fetch('/api/proxy/jaeger/api/services');
      if (response.ok) {
        const data = await response.json();
        const services = data.data || [];
        setAvailableServices(services);
      }
    } catch (err) {
      // Error fetching services
    }
  }, [fetchApi]);

  const fetchTraces = useCallback(async (): Promise<number> => {
    setLoading(true);
    setError(null);
    try {
      // Use lookback parameter instead of start/end timestamps
      let lookback = '1h'; // default
      if (timeRange === '5m') {
        lookback = '5m';
      } else if (timeRange === '24h') {
        lookback = '24h';
      } else if (timeRange === '7d') {
        lookback = '168h'; // 7 days in hours
      }

      const tracesUrl = `/api/proxy/jaeger/api/traces?service=${encodeURIComponent(
        serviceName,
      )}&lookback=${lookback}&limit=100`;

      const response = await fetchApi.fetch(tracesUrl);

      if (!response.ok) {
        setTraces([]);
        setLoading(false);
        return 0;
      }

      // Check if response is actually JSON
      const contentType = response.headers.get('content-type');
      
      if (!contentType || !contentType.includes('application/json')) {
        setTraces([]);
        setLoading(false);
        return 0;
      }

      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        setTraces([]);
        setLoading(false);
        return 0;
      }

      const fetchedTraces = data.data || [];
      setTraces(fetchedTraces);
      return fetchedTraces.length;
    } catch (err) {
      setTraces([]);
      return 0;
    } finally {
      setLoading(false);
    }
  }, [fetchApi, serviceName, timeRange]);

  const autoStartService = useCallback(async () => {
    // Skip auto-start if no repo name available (service not in catalog)
    if (!repoName) {
      return;
    }

    setAutoStarting(true);
    try {
      const response = await fetchApi.fetch('/api/function-analytics/service/start-and-trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName, repoName }),
      });

      if (response.ok) {
        // Refresh available services and traces
        await fetchAvailableServices();
        await fetchTraces();
      }
    } catch (err) {
      // Auto-start failed
    } finally {
      setAutoStarting(false);
    }
  }, [fetchApi, serviceName, repoName, fetchAvailableServices, fetchTraces]);

  const checkAndStartService = useCallback(async () => {
    // First, check if service already has traces
    const traceCount = await fetchTraces();
    
    // If no traces found and service not in Jaeger, try to auto-start
    if (traceCount === 0 && !availableServices.includes(serviceName)) {
      await autoStartService();
    }
  }, [fetchTraces, availableServices, serviceName, autoStartService]);

  useEffect(() => {
    fetchAvailableServices();
  }, [fetchAvailableServices]);

  useEffect(() => {
    if (serviceName && serviceName !== 'all') {
      checkAndStartService();
    }
  }, [serviceName, checkAndStartService]);

  const toggleTrace = (traceID: string) => {
    const newExpanded = new Set(expandedTraces);
    if (newExpanded.has(traceID)) {
      newExpanded.delete(traceID);
    } else {
      newExpanded.add(traceID);
    }
    setExpandedTraces(newExpanded);
  };

  const formatDuration = (microseconds: number): string => {
    if (microseconds < 1000) return `${microseconds}µs`;
    if (microseconds < 1000000) return `${(microseconds / 1000).toFixed(2)}ms`;
    return `${(microseconds / 1000000).toFixed(2)}s`;
  };

  const getTagValue = (tags: Array<{ key: string; value: any }>, key: string): any => {
    const tag = tags.find(t => t.key === key);
    return tag ? tag.value : null;
  };

  const isErrorSpan = (span: Span): boolean => {
    return getTagValue(span.tags, 'error') === true || getTagValue(span.tags, 'http.status_code') >= 400;
  };

  if (loading || autoStarting) {
    return (
      <Box p={3}>
        <LinearProgress />
        <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>
          {autoStarting 
            ? `🚀 Starting ${serviceName} and generating traces... This may take 15-20 seconds.`
            : `Loading traces for ${serviceName}...`}
        </Typography>
        {autoStarting && (
          <Typography variant="caption" color="textSecondary" style={{ marginTop: 8, display: 'block' }}>
            • Starting Docker containers<br/>
            • Waiting for services to initialize<br/>
            • Generating 20 sample requests<br/>
            • Collecting traces from Jaeger
          </Typography>
        )}
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={3}>
        <Alert severity="error">
          <Typography variant="body1">{error}</Typography>
        </Alert>
      </Box>
    );
  }

  if (traces.length === 0) {
    return (
      <Box p={3}>
        <Alert severity="warning">
          <Typography variant="h6" gutterBottom>
            No traces found for "{serviceName}"
          </Typography>
          
          {availableServices.length > 0 && (
            <Box mb={2} p={2} bgcolor="#f0f7ff" borderRadius={1}>
              <Typography variant="body2" gutterBottom>
                <strong>📋 Services currently in Jaeger:</strong>
              </Typography>
              <Box component="ul" pl={2}>
                {availableServices.map(svc => (
                  <li key={svc}>
                    <Typography variant="body2" component="span">
                      <code>{svc}</code>
                      {svc === serviceName && <Chip label="Selected" size="small" color="primary" style={{ marginLeft: 8 }} />}
                    </Typography>
                  </li>
                ))}
              </Box>
            </Box>
          )}

          <Typography variant="body2" paragraph>
            This could mean:
          </Typography>
          <Box component="ul" pl={2}>
            <li>
              <Typography variant="body2">
                <strong>Service name mismatch</strong> - Your service might be sending traces with a different name. 
                Check the OTEL_SERVICE_NAME environment variable in your service.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                <strong>Service hasn't generated traces yet</strong> - Make some requests to the service to generate traces
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                <strong>OpenTelemetry not configured</strong> - Your service needs OpenTelemetry instrumentation to send traces
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                <strong>Wrong time range</strong> - Try selecting a longer time range (24h or 7d)
              </Typography>
            </li>
          </Box>
          <Box mt={2}>
            <Typography variant="body2">
              <strong>Troubleshooting:</strong>
            </Typography>
            <Box component="code" display="block" bgcolor="#f5f5f5" p={1} mt={1}>
              1. Check Jaeger UI: <Link href="http://localhost:16686" target="_blank" rel="noopener">http://localhost:16686</Link><br/>
              2. Verify service logs for OpenTelemetry/tracing errors<br/>
              3. Check service's OTEL_EXPORTER_OTLP_ENDPOINT is set to http://localhost:4318
            </Box>
          </Box>
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2} p={2}>
        <Typography variant="h6">
          Found {traces.length} trace{traces.length !== 1 ? 's' : ''} for {serviceName}
        </Typography>
        <Link
          href={`http://localhost:16686/search?service=${encodeURIComponent(serviceName)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Box display="flex" alignItems="center" style={{ gap: 4 }}>
            Open in Jaeger UI
            <OpenInNewIcon fontSize="small" />
          </Box>
        </Link>
      </Box>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell width={50} />
              <TableCell>Trace ID</TableCell>
              <TableCell>Spans</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Start Time</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {traces.map(trace => {
              const totalDuration = Math.max(...trace.spans.map(s => s.duration));
              const spanCount = trace.spans.length;
              const startTime = Math.min(...trace.spans.map(s => s.startTime));
              const isExpanded = expandedTraces.has(trace.traceID);
              const hasError = trace.spans.some(s => isErrorSpan(s));

              return (
                <>
                  <TableRow
                    key={trace.traceID}
                    className={classes.traceRow}
                    onClick={() => toggleTrace(trace.traceID)}
                  >
                    <TableCell>
                      <IconButton size="small">
                        {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" style={{ fontFamily: 'monospace' }}>
                        {trace.traceID.substring(0, 16)}...
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={`${spanCount} spans`} size="small" />
                    </TableCell>
                    <TableCell>
                      <Box>
                        <Typography variant="body2">{formatDuration(totalDuration)}</Typography>
                        <LinearProgress
                          variant="determinate"
                          value={100}
                          className={classes.durationBar}
                        />
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={hasError ? 'Error' : 'Success'}
                        size="small"
                        className={hasError ? classes.errorChip : classes.successChip}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(startTime / 1000).toLocaleString()}
                      </Typography>
                    </TableCell>
                  </TableRow>

                  {/* Expanded span details */}
                  <TableRow>
                    <TableCell colSpan={6} style={{ paddingBottom: 0, paddingTop: 0 }}>
                      <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                        <Box margin={2}>
                          <Typography variant="h6" gutterBottom>
                            Spans
                          </Typography>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Operation</TableCell>
                                <TableCell>Service</TableCell>
                                <TableCell>Duration</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell>Tags</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {trace.spans.map(span => {
                                const process = trace.processes[span.processID] || Object.values(trace.processes)[0];
                                const httpMethod = getTagValue(span.tags, 'http.method');
                                const httpStatus = getTagValue(span.tags, 'http.status_code');

                                return (
                                  <TableRow key={span.spanID} className={classes.spanRow}>
                                    <TableCell>
                                      <Typography variant="body2">{span.operationName}</Typography>
                                      {httpMethod && (
                                        <Chip
                                          label={httpMethod}
                                          size="small"
                                          style={{ marginTop: 4 }}
                                        />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      <Typography variant="body2">
                                        {process?.serviceName || 'unknown'}
                                      </Typography>
                                    </TableCell>
                                    <TableCell>
                                      <Box>
                                        <Typography variant="body2">
                                          {formatDuration(span.duration)}
                                        </Typography>
                                        <LinearProgress
                                          variant="determinate"
                                          value={(span.duration / totalDuration) * 100}
                                          className={classes.durationBar}
                                        />
                                      </Box>
                                    </TableCell>
                                    <TableCell>
                                      {httpStatus && (
                                        <Chip
                                          label={httpStatus}
                                          size="small"
                                          className={
                                            httpStatus >= 400 ? classes.errorChip : classes.successChip
                                          }
                                        />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      <Box display="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                                        {span.tags
                                          .filter(t => !['http.method', 'http.status_code', 'span.kind'].includes(t.key))
                                          .slice(0, 3)
                                          .map(tag => (
                                            <Chip
                                              key={tag.key}
                                              label={`${tag.key}: ${tag.value}`}
                                              size="small"
                                              variant="outlined"
                                            />
                                          ))}
                                      </Box>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
