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

import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Typography,
  Stepper,
  Step,
  StepLabel,
  StepContent,
  LinearProgress,
  Grid,
  Button,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import AccessTimeIcon from '@material-ui/icons/AccessTime';
import RefreshIcon from '@material-ui/icons/Refresh';
import { Alert } from '@material-ui/lab';

const useStyles = makeStyles(theme => ({
  card: {
    marginBottom: theme.spacing(2),
  },
  stepContent: {
    paddingLeft: 0,
    paddingRight: 0,
  },
  statusBox: {
    padding: theme.spacing(2),
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(2),
    borderRadius: theme.spacing(1),
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    backgroundColor: theme.palette.background.default,
    maxHeight: 200,
    overflowY: 'auto',
  },
  successStatus: {
    backgroundColor: '#e8f5e9',
    borderLeft: '4px solid #4caf50',
  },
  errorStatus: {
    backgroundColor: '#ffebee',
    borderLeft: '4px solid #f44336',
  },
  pendingStatus: {
    backgroundColor: '#fff3e0',
    borderLeft: '4px solid #ff9800',
  },
  dataFlowDiagram: {
    padding: theme.spacing(3),
    backgroundColor: theme.palette.background.default,
    borderRadius: theme.spacing(1),
    marginBottom: theme.spacing(2),
  },
  flowStep: {
    flex: 1,
    textAlign: 'center',
    position: 'relative',
  },
  flowArrow: {
    fontSize: '1.5rem',
    margin: '0 8px',
    alignSelf: 'center',
  },
  checkIcon: {
    color: '#4caf50',
  },
  errorIcon: {
    color: '#f44336',
  },
  pendingIcon: {
    color: '#ff9800',
  },
}));

interface DataFlowStep {
  name: string;
  status: 'idle' | 'loading' | 'success' | 'error';
  message?: string;
  details?: string;
}

interface DataFlowVisualizationProps {
  jaegerHealthy: boolean | null;
  tracesCollected: number;
  servicesDeployed: number;
  isTracing: boolean;
}

export const DataFlowVisualization: React.FC<DataFlowVisualizationProps> = ({
  jaegerHealthy,
  tracesCollected,
  servicesDeployed,
  isTracing,
}) => {
  const classes = useStyles();
  const [steps, setSteps] = useState<DataFlowStep[]>([
    {
      name: 'Services Deployment',
      status: 'idle',
      message: 'Waiting to start...',
    },
    {
      name: 'OpenTelemetry Collection',
      status: 'idle',
      message: 'Waiting for services to initialize...',
    },
    {
      name: 'Jaeger Storage',
      status: 'idle',
      message: 'No traces received yet',
    },
    {
      name: 'Frontend Display',
      status: 'idle',
      message: 'Waiting for data from Jaeger',
    },
  ]);
  useEffect(() => {
    setSteps(prevSteps => {
      const updatedSteps = [...prevSteps];

      if (isTracing) {
        // Phase 1 – Services are being deployed
        updatedSteps[0].status = 'loading';
        updatedSteps[0].message = `Deploying ${servicesDeployed} services...`;

        // Phase 2 – OTel collection starts once services are up
        updatedSteps[1].status = servicesDeployed > 0 ? 'loading' : 'idle';
        updatedSteps[1].message =
          servicesDeployed > 0
            ? `Collecting traces from ${servicesDeployed} services...`
            : 'Waiting for services to spin up...';

        // Phase 3 – Jaeger is receiving data (show as loading, not idle)
        updatedSteps[2].status = servicesDeployed > 0 ? 'loading' : 'idle';
        updatedSteps[2].message =
          servicesDeployed > 0
            ? 'Waiting for OpenTelemetry data to reach Jaeger...'
            : 'Waiting for services...';

        // Phase 4 – Frontend waits for Jaeger data
        updatedSteps[3].status = 'idle';
        updatedSteps[3].message = 'Waiting for Jaeger data...';
      } else if (jaegerHealthy === null) {
        // Not yet checked
        updatedSteps[2].status = 'loading';
        updatedSteps[2].message = 'Checking Jaeger connection...';
      } else if (jaegerHealthy === false) {
        // Jaeger is unreachable — mark error and cascade
        updatedSteps[2].status = 'error';
        updatedSteps[2].message =
          'Jaeger unreachable (localhost:16686) — ensure Jaeger container is running';
        updatedSteps[3].status = 'error';
        updatedSteps[3].message = 'Cannot display data without Jaeger';
      } else if (jaegerHealthy === true && servicesDeployed > 0) {
        // Happy path — Jaeger up and services deployed
        updatedSteps[0].status = 'success';
        updatedSteps[0].message = `✅ ${servicesDeployed} service(s) deployed`;

        updatedSteps[1].status = 'success';
        updatedSteps[1].message = '✅ OpenTelemetry agents enabled';

        updatedSteps[2].status = tracesCollected > 0 ? 'success' : 'loading';
        updatedSteps[2].message =
          tracesCollected > 0
            ? `✅ ${tracesCollected} trace(s) stored in Jaeger`
            : 'Collecting traces — waiting for first batch...';

        updatedSteps[3].status = tracesCollected > 0 ? 'success' : 'loading';
        updatedSteps[3].message =
          tracesCollected > 0
            ? `✅ Displaying ${tracesCollected} function call(s)`
            : 'Waiting for traces to display...';
      } else if (jaegerHealthy === true && servicesDeployed === 0) {
        // Jaeger healthy but no services selected/deployed yet
        updatedSteps[2].status = 'loading';
        updatedSteps[2].message =
          'Jaeger connected — waiting for services to be deployed';
      }

      return updatedSteps;
    });
  }, [isTracing, jaegerHealthy, tracesCollected, servicesDeployed]);

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircleIcon className={classes.checkIcon} />;
      case 'error':
        return <ErrorIcon className={classes.errorIcon} />;
      case 'loading':
        return <AccessTimeIcon className={classes.pendingIcon} />;
      default:
        return <AccessTimeIcon />;
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'success':
        return classes.successStatus;
      case 'error':
        return classes.errorStatus;
      default:
        return classes.pendingStatus;
    }
  };

  const activeStep = steps.findIndex(
    s => s.status === 'loading' || s.status === 'idle',
  );

  return (
    <Card className={classes.card}>
      <CardHeader
        title="📊 Data Flow: Services → OpenTelemetry → Jaeger → Frontend"
        subheader="Real-time tracing pipeline status"
      />
      <CardContent>
        {/* Visual Flow Diagram */}
        <Box
          className={classes.dataFlowDiagram}
          display="flex"
          alignItems="center"
        >
          <Box className={classes.flowStep}>
            <Box display="flex" justifyContent="center" alignItems="center">
              {getStepIcon(steps[0].status)}
            </Box>
            <Typography variant="caption" display="block">
              Services
            </Typography>
            <Typography variant="caption" color="textSecondary" display="block">
              {servicesDeployed} deployed
            </Typography>
          </Box>
          <Box className={classes.flowArrow}>→</Box>
          <Box className={classes.flowStep}>
            <Box display="flex" justifyContent="center" alignItems="center">
              {getStepIcon(steps[1].status)}
            </Box>
            <Typography variant="caption" display="block">
              OTel
            </Typography>
            <Typography variant="caption" color="textSecondary" display="block">
              Tracing
            </Typography>
          </Box>
          <Box className={classes.flowArrow}>→</Box>
          <Box className={classes.flowStep}>
            <Box display="flex" justifyContent="center" alignItems="center">
              {getStepIcon(steps[2].status)}
            </Box>
            <Typography variant="caption" display="block">
              Jaeger
            </Typography>
            <Typography variant="caption" color="textSecondary" display="block">
              {tracesCollected} traces
            </Typography>
          </Box>
          <Box className={classes.flowArrow}>→</Box>
          <Box className={classes.flowStep}>
            <Box display="flex" justifyContent="center" alignItems="center">
              {getStepIcon(steps[3].status)}
            </Box>
            <Typography variant="caption" display="block">
              Frontend
            </Typography>
            <Typography variant="caption" color="textSecondary" display="block">
              Display
            </Typography>
          </Box>
        </Box>

        {/* Step-by-step Progress */}
        <Stepper activeStep={activeStep} orientation="vertical">
          {steps.map((step, index) => (
            <Step key={index} completed={step.status === 'success'}>
              <StepLabel
                icon={getStepIcon(step.status)}
                error={step.status === 'error'}
              >
                {step.name}
              </StepLabel>
              <StepContent className={classes.stepContent}>
                <Box
                  className={`${classes.statusBox} ${getStatusClass(
                    step.status,
                  )}`}
                >
                  <Typography variant="body2">{step.message}</Typography>
                  {step.status === 'loading' && (
                    <Box mt={1}>
                      <LinearProgress />
                    </Box>
                  )}
                </Box>
              </StepContent>
            </Step>
          ))}
        </Stepper>

        {/* Status Summary */}
        <Grid container spacing={2} style={{ marginTop: 16 }}>
          <Grid item xs={12} sm={6}>
            <Alert severity={servicesDeployed > 0 ? 'success' : 'info'}>
              <Typography variant="body2">
                <strong>Services:</strong> {servicesDeployed} deployed
              </Typography>
            </Alert>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Alert severity={tracesCollected > 0 ? 'success' : 'warning'}>
              <Typography variant="body2">
                <strong>Traces:</strong> {tracesCollected} collected
              </Typography>
            </Alert>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Alert severity={jaegerHealthy ? 'success' : 'error'}>
              <Typography variant="body2">
                <strong>Jaeger:</strong>{' '}
                {jaegerHealthy ? 'Connected' : 'Disconnected'}
              </Typography>
            </Alert>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Alert
              severity={
                tracesCollected > 0 && jaegerHealthy ? 'success' : 'info'
              }
            >
              <Typography variant="body2">
                <strong>Frontend:</strong>{' '}
                {tracesCollected > 0 ? 'Displaying data' : 'Waiting for data'}
              </Typography>
            </Alert>
          </Grid>
        </Grid>

        {/* Quick Links */}
        <Box mt={2} display="flex" style={{ gap: 8 }}>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
          {jaegerHealthy && (
            <Button
              size="small"
              href="http://localhost:16686"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Jaeger
            </Button>
          )}
        </Box>
      </CardContent>
    </Card>
  );
};
