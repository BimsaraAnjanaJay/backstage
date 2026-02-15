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

import { Fragment, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  LinearProgress,
  Grid,
  Collapse,
  IconButton,
} from '@material-ui/core';
import { Alert, AlertTitle } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import ExpandLessIcon from '@material-ui/icons/ExpandLess';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import AccessTimeIcon from '@material-ui/icons/AccessTime';

const useStyles = makeStyles(theme => ({
  resultCard: {
    marginBottom: theme.spacing(3),
  },
  successRow: {
    backgroundColor: '#e8f5e9',
  },
  failedRow: {
    backgroundColor: '#ffebee',
  },
  partialRow: {
    backgroundColor: '#fff3e0',
  },
  resultMetric: {
    padding: theme.spacing(2),
    textAlign: 'center',
    borderRadius: theme.spacing(1),
    backgroundColor: theme.palette.background.default,
  },
  metricValue: {
    fontSize: '2rem',
    fontWeight: 'bold',
    color: theme.palette.primary.main,
  },
  metricLabel: {
    fontSize: '0.875rem',
    color: theme.palette.text.secondary,
    marginTop: theme.spacing(0.5),
  },
  expandButton: {
    marginLeft: 'auto',
  },
  detailsTable: {
    marginTop: theme.spacing(2),
  },
  dataFlowStep: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: theme.spacing(1),
    padding: theme.spacing(1),
    backgroundColor: theme.palette.background.default,
    borderRadius: theme.spacing(0.5),
  },
  dataFlowIcon: {
    marginRight: theme.spacing(1),
    minWidth: 24,
  },
  dataFlowLabel: {
    flex: 1,
  },
  traceCountBadge: {
    marginLeft: 'auto',
    fontWeight: 'bold',
  },
}));

export interface GroupTraceResult {
  serviceName: string;
  jaegerServiceName: string;
  deployStatus: 'started' | 'failed' | 'skipped';
  tracesInJaeger: number;
  traceQueryStatus: 'ok' | 'failed';
  message: string;
  startTime?: number;
  endTime?: number;
  latency?: number;
}

interface GroupTraceResultsDisplayProps {
  results: GroupTraceResult[];
  isLoading: boolean;
  error: string | null;
  jaegerHealthy: boolean | null;
  systemName: string;
}

export const GroupTraceResultsDisplay: React.FC<GroupTraceResultsDisplayProps> = ({
  results,
  isLoading,
  error,
  jaegerHealthy,
  systemName,
}) => {
  const classes = useStyles();
  const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set());

  const toggleServiceExpand = (serviceName: string) => {
    const newExpanded = new Set(expandedServices);
    if (newExpanded.has(serviceName)) {
      newExpanded.delete(serviceName);
    } else {
      newExpanded.add(serviceName);
    }
    setExpandedServices(newExpanded);
  };

  const getRowClass = (result: GroupTraceResult): string => {
    if (result.deployStatus === 'failed') {
      return classes.failedRow;
    }
    if (result.tracesInJaeger === 0) {
      return classes.partialRow;
    }
    return classes.successRow;
  };

  const successCount = results.filter(r => r.deployStatus === 'started' && r.tracesInJaeger > 0).length;
  const failedCount = results.filter(r => r.deployStatus === 'failed').length;
  const totalTraces = results.reduce((sum, r) => sum + r.tracesInJaeger, 0);

  if (isLoading) {
    return (
      <Card className={classes.resultCard}>
        <CardHeader title="Group Tracing Results" />
        <CardContent>
          <Box display="flex" alignItems="center" style={{ gap: 16 }}>
            <Box flex={1}>
              <LinearProgress />
              <Typography variant="body2" color="textSecondary" style={{ marginTop: 12 }}>
                Starting tracing for all services in "{systemName}"...
              </Typography>
              <Typography variant="caption" color="textSecondary">
                • Deploying Docker containers<br/>
                • Waiting for services initialization (15-20s)<br/>
                • Generating sample HTTP requests<br/>
                • Collecting OpenTelemetry traces in Jaeger
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={classes.resultCard}>
        <CardHeader title="Group Tracing Results" />
        <CardContent>
          <Alert severity="error">
            <AlertTitle>Tracing Failed</AlertTitle>
            {error}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (results.length === 0) {
    return (
      <Card className={classes.resultCard}>
        <CardHeader title="Group Tracing Results" />
        <CardContent>
          <Alert severity="info">
            <AlertTitle>No Results</AlertTitle>
            No services to trace or tracing results are not available yet.
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={classes.resultCard}>
      <CardHeader 
        title="Group Tracing Results"
        subheader={`System: ${systemName} • ${new Date().toLocaleString()}`}
      />
      <CardContent>
        {jaegerHealthy === false && (
          <Alert severity="warning" style={{ marginBottom: 16 }}>
            <AlertTitle>Jaeger Connection Issues</AlertTitle>
            Jaeger may be unreachable. Check if it's running on <code>localhost:16686</code>
          </Alert>
        )}

        {/* Summary Metrics */}
        <Grid container spacing={2} style={{ marginBottom: 24 }}>
          <Grid item xs={12} sm={6} md={3}>
            <Box className={classes.resultMetric}>
              <Box className={classes.metricValue}>{successCount}</Box>
              <Box className={classes.metricLabel}>Services with Traces</Box>
            </Box>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Box className={classes.resultMetric}>
              <Box className={classes.metricValue}>{totalTraces}</Box>
              <Box className={classes.metricLabel}>Total Traces Collected</Box>
            </Box>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Box className={classes.resultMetric}>
              <Box className={classes.metricValue}>{failedCount}</Box>
              <Box className={classes.metricLabel}>Failed Services</Box>
            </Box>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Box className={classes.resultMetric}>
              <Box className={classes.metricValue} style={{ 
                color: jaegerHealthy ? '#4caf50' : '#f44336' 
              }}>
                {jaegerHealthy ? '✓' : '✗'}
              </Box>
              <Box className={classes.metricLabel}>Jaeger Status</Box>
            </Box>
          </Grid>
        </Grid>

        {/* Data Flow Visualization */}
        <Box style={{ marginBottom: 24 }}>
          <Typography variant="h6" gutterBottom>
            📊 Data Flow: OpenTelemetry → Jaeger → Frontend
          </Typography>
          {results.map((result, index) => {
            const hasTraces = result.tracesInJaeger > 0;
            const isDeployed = result.deployStatus === 'started';
            const getIcon = () => {
              if (hasTraces && isDeployed) return <CheckCircleIcon style={{ color: '#4caf50' }} />;
              if (result.deployStatus === 'failed') return <ErrorIcon style={{ color: '#f44336' }} />;
              return <AccessTimeIcon style={{ color: '#ff9800' }} />;
            };
            return (
              <Box key={index} className={classes.dataFlowStep}>
                <Box className={classes.dataFlowIcon}>
                  {getIcon()}
                </Box>
                <Box className={classes.dataFlowLabel}>
                  <Typography variant="body2" style={{ fontWeight: 500 }}>
                    {result.serviceName}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    {result.jaegerServiceName}
                  </Typography>
                </Box>
                <Chip 
                  label={`${result.tracesInJaeger} traces`}
                  size="small"
                  color={hasTraces ? 'primary' : 'default'}
                  className={classes.traceCountBadge}
                />
              </Box>
            );
          })}
        </Box>

        {/* Detailed Results Table */}
        <Typography variant="h6" gutterBottom style={{ marginTop: 24 }}>
          📋 Detailed Results
        </Typography>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Service</TableCell>
                <TableCell>Jaeger Service</TableCell>
                <TableCell>Deployment</TableCell>
                <TableCell>Traces</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Details</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {results.map((result, index) => {
                const isExpanded = expandedServices.has(result.serviceName);

                return (
                  <Fragment key={index}>
                    <TableRow className={getRowClass(result)}>
                      <TableCell>{result.serviceName}</TableCell>
                      <TableCell>
                        <code style={{ fontSize: '0.85rem' }}>{result.jaegerServiceName}</code>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={result.deployStatus}
                          size="small"
                          color={result.deployStatus === 'started' ? 'primary' : 'default'}
                          icon={result.deployStatus === 'started' ? <CheckCircleIcon /> : <ErrorIcon />}
                        />
                      </TableCell>
                      <TableCell>
                        <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                          <Typography variant="body2">{result.tracesInJaeger}</Typography>
                          {result.tracesInJaeger > 0 && (
                            <Chip 
                              label="✓ Data Received" 
                              size="small" 
                              style={{ backgroundColor: '#c8e6c9', color: '#2e7d32' }}
                            />
                          )}
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={result.traceQueryStatus}
                          size="small"
                          color={result.traceQueryStatus === 'ok' ? 'primary' : 'secondary'}
                        />
                      </TableCell>
                      <TableCell align="center">
                        <IconButton
                          size="small"
                          onClick={() => toggleServiceExpand(result.serviceName)}
                          className={classes.expandButton}
                        >
                          {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                        </IconButton>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={6} style={{ paddingBottom: 0, paddingTop: 0 }}>
                        <Collapse in={isExpanded} timeout="auto">
                          <Box style={{ padding: 16 }}>
                            <Typography variant="subtitle2" gutterBottom>
                              Message
                            </Typography>
                            <Typography variant="body2" color="textSecondary" style={{ fontFamily: 'monospace' }}>
                              {result.message}
                            </Typography>
                            {result.latency && (
                              <>
                                <Typography variant="subtitle2" gutterBottom style={{ marginTop: 12 }}>
                                  Latency
                                </Typography>
                                <Typography variant="body2" color="textSecondary">
                                  {result.latency}ms
                                </Typography>
                              </>
                            )}
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>

        {/* Summary Alert */}
        <Alert severity={failedCount === 0 ? 'success' : 'warning'} style={{ marginTop: 16 }}>
          <AlertTitle>
            {failedCount === 0 ? '✅ Tracing Completed Successfully' : '⚠️ Tracing Completed with Issues'}
          </AlertTitle>
          <Typography variant="body2">
            • {successCount}/{results.length} services traced successfully<br/>
            • {totalTraces} total traces collected<br/>
            • Data is now available in Jaeger (<code>localhost:16686</code>)<br/>
            • Frontend is displaying collected metrics and function calls
          </Typography>
        </Alert>
      </CardContent>
    </Card>
  );
};
