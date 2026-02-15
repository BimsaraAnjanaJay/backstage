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

import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stepper,
  Step,
  StepLabel,
  TextField,
  Typography,
  Paper,
  Grid,
  List,
  ListItem,
  ListItemText,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import SettingsIcon from '@material-ui/icons/Settings';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import VisibilityIcon from '@material-ui/icons/Visibility';
import { useApi, configApiRef, errorApiRef } from '@backstage/core-plugin-api';

interface DetectedService {
  name: string;
  language: 'nodejs' | 'python' | 'go' | 'java';
  path: string;
  port: number;
  hasDockerfile: boolean;
  entrypoint?: string;
}

interface ConfigurationStatus {
  step: string;
  status: 'pending' | 'running' | 'success' | 'error';
  message?: string;
}

const steps = [
  'Repository URL',
  'Detect Services',
  'Generate Config',
  'Deploy & Trace',
];

export const MicroserviceConfigWizard = () => {
  const [activeStep, setActiveStep] = useState(0);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [loading, setLoading] = useState(false);
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  const [configStatus, setConfigStatus] = useState<ConfigurationStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deployedServices, setDeployedServices] = useState<any[]>([]);

  const configApi = useApi(configApiRef);
  const errorApi = useApi(errorApiRef);

  const backendUrl = configApi.getString('backend.baseUrl');

  const handleDetectServices = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${backendUrl}/api/function-analytics/microservice/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to detect services');
      }

      const data = await response.json();
      setDetectedServices(data.services);
      setRepoName(data.repoName);
      setActiveStep(1);
    } catch (err: any) {
      setError(err.message);
      errorApi.post(new Error(`Service detection failed: ${err.message}`));
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateConfig = async () => {
    setLoading(true);
    setError(null);

    const statusUpdates: ConfigurationStatus[] = [
      { step: 'docker-compose', status: 'pending' },
      { step: 'catalog-info', status: 'pending' },
      { step: 'instrumentation', status: 'pending' },
      { step: 'scripts', status: 'pending' },
    ];

    setConfigStatus(statusUpdates);

    try {
      for (let i = 0; i < statusUpdates.length; i++) {
        statusUpdates[i].status = 'running';
        setConfigStatus([...statusUpdates]);

        const response = await fetch(`${backendUrl}/api/function-analytics/microservice/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoName,
            repoUrl,
            services: detectedServices,
            step: statusUpdates[i].step,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to generate ${statusUpdates[i].step}`);
        }

        const data = await response.json();
        
        statusUpdates[i].status = 'success';
        statusUpdates[i].message = data.message;
        setConfigStatus([...statusUpdates]);
      }

      setActiveStep(2);
    } catch (err: any) {
      const failedStep = statusUpdates.find(s => s.status === 'running');
      if (failedStep) {
        failedStep.status = 'error';
        failedStep.message = err.message;
        setConfigStatus([...statusUpdates]);
      }
      setError(err.message);
      errorApi.post(new Error(`Configuration failed: ${err.message}`));
    } finally {
      setLoading(false);
    }
  };

  const handleDeploy = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${backendUrl}/api/function-analytics/microservice/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoName,
          services: detectedServices,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to deploy services');
      }

      const data = await response.json();
      setDeployedServices(data.services);
      setActiveStep(3);
    } catch (err: any) {
      setError(err.message);
      errorApi.post(new Error(`Deployment failed: ${err.message}`));
    } finally {
      setLoading(false);
    }
  };

  const renderStepContent = () => {
    switch (activeStep) {
      case 0:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Enter Microservice Repository URL
            </Typography>
            <TextField
              fullWidth
              label="Git Repository URL"
              placeholder="https://github.com/username/microservice-repo"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
              variant="outlined"
              helperText="Enter the Git URL of your microservice repository"
              margin="normal"
            />
            
              <Box mt={3}>
              <Typography variant="body2" color="textSecondary" gutterBottom>
                Supported Languages:
              </Typography>
              <Box display="flex" style={{ gap: 8 }} flexWrap="wrap">
                <Chip label="Node.js" size="small" color="primary" />
                <Chip label="Python" size="small" color="primary" />
                <Chip label="Go" size="small" color="primary" />
                <Chip label="Java/Spring Boot" size="small" color="primary" />
              </Box>
            </Box>

            <Box mt={3}>
              <Alert severity="info">
                <Typography variant="body2" gutterBottom>
                  <strong>What this wizard does:</strong>
                </Typography>
                <List dense>
                  <ListItem>
                    <ListItemText primary="1. Automatically detects all services in your repository" />
                  </ListItem>
                  <ListItem>
                    <ListItemText primary="2. Generates OpenTelemetry configuration with Jaeger" />
                  </ListItem>
                  <ListItem>
                    <ListItemText primary="3. Creates Backstage catalog entries" />
                  </ListItem>
                  <ListItem>
                    <ListItemText primary="4. Deploys services and starts collecting traces" />
                  </ListItem>
                </List>
              </Alert>
            </Box>

            <Box mt={3} display="flex" justifyContent="flex-end">
              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={handleDetectServices}
                disabled={!repoUrl || loading}
                startIcon={loading ? <CircularProgress size={20} /> : <PlayArrowIcon />}
              >
                {loading ? 'Detecting Services...' : 'Start Configuration'}
              </Button>
            </Box>
          </Box>
        );

      case 1:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Detected Services in {repoName}
            </Typography>
            
            {detectedServices.length === 0 ? (
              <Alert severity="warning">
                No services detected. Please verify your repository structure.
              </Alert>
            ) : (
              <>
                <Alert severity="success" style={{ marginBottom: 16 }}>
                  Found {detectedServices.length} service(s) ready for configuration
                </Alert>

                <Grid container spacing={2}>
                  {detectedServices.map((service, index) => (
                    <Grid item xs={12} md={6} key={index}>
                      <Card variant="outlined">
                        <CardContent>
                          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                            <Typography variant="h6">{service.name}</Typography>
                            <Chip 
                              label={service.language.toUpperCase()} 
                              color="primary" 
                              size="small"
                            />
                          </Box>
                          
                          <Typography variant="body2" color="textSecondary" gutterBottom>
                            📁 Path: {service.path}
                          </Typography>
                          <Typography variant="body2" color="textSecondary" gutterBottom>
                            🔌 Port: {service.port}
                          </Typography>
                          {service.entrypoint && (
                            <Typography variant="body2" color="textSecondary" gutterBottom>
                              🚀 Entry: {service.entrypoint}
                            </Typography>
                          )}

                          <Box mt={2} display="flex" style={{ gap: 8 }}>
                            {service.hasDockerfile && (
                              <Chip 
                                icon={<CheckCircleIcon />} 
                                label="Has Dockerfile" 
                                size="small" 
                                color="default"
                                variant="outlined"
                              />
                            )}
                            <Chip 
                              icon={<CheckCircleIcon />} 
                              label="OpenTelemetry Ready" 
                              size="small" 
                              color="secondary"
                              variant="outlined"
                            />
                          </Box>
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>

                <Box mt={3} display="flex" justifyContent="space-between">
                  <Button onClick={() => setActiveStep(0)} disabled={loading}>
                    Back
                  </Button>
                  <Button
                    variant="contained"
                    color="primary"
                    size="large"
                    onClick={handleGenerateConfig}
                    disabled={loading || detectedServices.length === 0}
                    startIcon={loading ? <CircularProgress size={20} /> : <SettingsIcon />}
                  >
                    {loading ? 'Generating...' : 'Generate Configuration'}
                  </Button>
                </Box>
              </>
            )}
          </Box>
        );

      case 2:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Configuration Progress
            </Typography>

            <Box mt={2}>
              {configStatus.map((status, index) => (
                <Box key={index} mb={2}>
                  <Paper variant="outlined" style={{ padding: 16 }}>
                    <Box display="flex" alignItems="center" style={{ gap: 16 }}>
                      {status.status === 'pending' && <CircularProgress size={24} />}
                      {status.status === 'running' && <CircularProgress size={24} />}
                      {status.status === 'success' && <CheckCircleIcon style={{ color: '#4caf50', fontSize: 32 }} />}
                      {status.status === 'error' && <ErrorIcon style={{ color: '#f44336', fontSize: 32 }} />}
                      
                      <Box flex={1}>
                        <Typography variant="body1" style={{ fontWeight: 500 }}>
                          {status.step.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                        </Typography>
                        {status.message && (
                          <Typography variant="body2" color="textSecondary">
                            {status.message}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  </Paper>
                </Box>
              ))}
            </Box>

            {configStatus.every(s => s.status === 'success') && (
              <>
                <Alert severity="success" style={{ marginTop: 16 }}>
                  ✅ All configuration files generated successfully!
                </Alert>

                <Box mt={3}>
                  <Typography variant="body2" color="textSecondary" gutterBottom>
                    Generated Files:
                  </Typography>
                  <List dense>
                    <ListItem>
                      <ListItemText 
                        primary="✓ docker-compose.otel.yml"
                        secondary="Docker Compose with Jaeger and OpenTelemetry"
                      />
                    </ListItem>
                    <ListItem>
                      <ListItemText 
                        primary="✓ catalog-info.yaml"
                        secondary="Backstage catalog entries for all services"
                      />
                    </ListItem>
                    <ListItem>
                      <ListItemText 
                        primary="✓ Startup scripts"
                        secondary="Scripts to manage services"
                      />
                    </ListItem>
                    {detectedServices.some(s => s.language === 'go') && (
                      <ListItem>
                        <ListItemText 
                          primary="✓ tracing.go"
                          secondary="OpenTelemetry instrumentation for Go"
                        />
                      </ListItem>
                    )}
                  </List>
                </Box>

                <Box mt={3} display="flex" justifyContent="space-between">
                  <Button onClick={() => setActiveStep(1)} disabled={loading}>
                    Back
                  </Button>
                  <Button
                    variant="contained"
                    color="primary"
                    size="large"
                    onClick={handleDeploy}
                    disabled={loading}
                    startIcon={loading ? <CircularProgress size={20} /> : <PlayArrowIcon />}
                  >
                    {loading ? 'Deploying Services...' : 'Deploy & Start Tracing'}
                  </Button>
                </Box>
              </>
            )}
          </Box>
        );

      case 3:
        return (
          <Box>
            <Alert severity="success" icon={<CheckCircleIcon fontSize="large" />} style={{ marginBottom: 24 }}>
              <Typography variant="h6">🎉 Services Deployed Successfully!</Typography>
              <Typography variant="body2">
                Your microservices are now running with distributed tracing enabled
              </Typography>
            </Alert>

            <Typography variant="h6" gutterBottom style={{ marginTop: 24 }}>
              📊 Access Your Services
            </Typography>

            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <Card style={{ backgroundColor: '#f5f5f5' }}>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      🔍 Jaeger Tracing UI
                    </Typography>
                    <Typography variant="body2" color="textSecondary" gutterBottom>
                      View distributed traces across all services
                    </Typography>
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      style={{ marginTop: 8 }}
                      onClick={() => window.open('http://localhost:16686', '_blank')}
                      startIcon={<VisibilityIcon />}
                    >
                      Open Jaeger UI
                    </Button>
                  </CardContent>
                </Card>
              </Grid>

              <Grid item xs={12} md={6}>
                <Card style={{ backgroundColor: '#f5f5f5' }}>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      📈 Function Analytics
                    </Typography>
                    <Typography variant="body2" color="textSecondary" gutterBottom>
                      Analyze function placement and performance
                    </Typography>
                    <Button
                      variant="contained"
                      color="secondary"
                      fullWidth
                      style={{ marginTop: 8 }}
                      onClick={() => { window.location.href = '/function-analytics'; }}
                      startIcon={<VisibilityIcon />}
                    >
                      View Analytics
                    </Button>
                  </CardContent>
                </Card>
              </Grid>

              {deployedServices.map((service, index) => (
                <Grid item xs={12} md={6} key={index}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        {service.name}
                      </Typography>
                      <Typography variant="body2" color="textSecondary" gutterBottom>
                        Running on port {service.port}
                      </Typography>
                      <Button
                        variant="outlined"
                        fullWidth
                        style={{ marginTop: 8 }}
                        onClick={() => window.open(service.url, '_blank')}
                      >
                        Open Service
                      </Button>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>

            <Box mt={4}>
              <Alert severity="info">
                <Typography variant="body2" gutterBottom>
                  <strong>Next Steps:</strong>
                </Typography>
                <List dense>
                  <ListItem>
                    <ListItemText primary="1. Access your services to generate traces automatically" />
                  </ListItem>
                  <ListItem>
                    <ListItemText primary="2. View traces in Jaeger UI to see service interactions" />
                  </ListItem>
                  <ListItem>
                    <ListItemText primary="3. Use Function Analytics to get placement recommendations" />
                  </ListItem>
                </List>
              </Alert>
            </Box>

            <Box mt={3}>
              <Button
                variant="contained"
                color="primary"
                fullWidth
                size="large"
                onClick={() => {
                  setActiveStep(0);
                  setRepoUrl('');
                  setDetectedServices([]);
                  setConfigStatus([]);
                  setDeployedServices([]);
                }}
              >
                Configure Another Repository
              </Button>
            </Box>
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        🚀 Microservice Configuration Wizard
      </Typography>
      <Typography variant="body1" color="textSecondary" paragraph>
        Automatically configure any microservice repository for distributed tracing
      </Typography>

      <Box mt={4} mb={4}>
        <Stepper activeStep={activeStep} alternativeLabel>
          {steps.map(label => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)} style={{ marginBottom: 16 }}>
          {error}
        </Alert>
      )}

      <Paper style={{ padding: 32, minHeight: 400 }}>
        {renderStepContent()}
      </Paper>
    </Box>
  );
};
