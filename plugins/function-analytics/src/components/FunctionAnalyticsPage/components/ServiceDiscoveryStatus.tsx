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

import {
  Card,
  CardContent,
  Typography,
  Box,
  Grid,
  IconButton,
  Tooltip,
  Button,
} from '@material-ui/core';
import { Alert, AlertTitle } from '@material-ui/lab';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import CancelIcon from '@material-ui/icons/Cancel';
import SettingsIcon from '@material-ui/icons/Settings';
import AddIcon from '@material-ui/icons/Add';
import CloudQueueIcon from '@material-ui/icons/CloudQueue';
import StorageIcon from '@material-ui/icons/Storage';
import RefreshIcon from '@material-ui/icons/Refresh';
import { HybridServiceConfig } from '../types';
import { useStyles } from '../styles';

interface ServiceDiscoveryStatusProps {
  allServices: HybridServiceConfig[];
  catalogServiceCount: number;
  manualServiceCount: number;
  onConfigureClick: () => void;
  onAddServiceClick: () => void;
  onTestJaeger: () => void;
}

/**
 * Displays service discovery status and connection information
 */
export const ServiceDiscoveryStatus = ({
  allServices,
  catalogServiceCount,
  manualServiceCount,
  onConfigureClick,
  onAddServiceClick,
  onTestJaeger,
}: ServiceDiscoveryStatusProps) => {
  const classes = useStyles();

  return (
    <Card className={classes.card}>
      <CardContent>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="h6">Service Discovery Status</Typography>
          <Tooltip title="Configure Services">
            <IconButton onClick={onConfigureClick}>
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Box>
        
        <Grid container spacing={2}>
          <Grid item xs={12} sm={4}>
            <Box className={classes.connectionStatus}>
              <CloudQueueIcon fontSize="small" />
              <Typography variant="body2">Catalog Services: {catalogServiceCount}</Typography>
            </Box>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Box className={classes.connectionStatus}>
              <StorageIcon fontSize="small" />
              <Typography variant="body2">Manual Services: {manualServiceCount}</Typography>
            </Box>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Box className={`${classes.connectionStatus} ${
              allServices.some(s => s.connectionStatus === 'connected') 
                ? classes.connected 
                : classes.disconnected
            }`}>
              {allServices.some(s => s.connectionStatus === 'connected') 
                ? <CheckCircleIcon fontSize="small" />
                : <CancelIcon fontSize="small" />
              }
              <Typography variant="body2">
                {allServices.filter(s => s.connectionStatus === 'connected').length} Connected
              </Typography>
            </Box>
          </Grid>
        </Grid>

        {allServices.length === 0 && (
          <Alert severity="info" style={{ marginTop: 16 }}>
            <AlertTitle>No Services Configured</AlertTitle>
            Configure services either through Backstage catalog annotations or manual configuration.
            <Box mt={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={onAddServiceClick}
                style={{ marginRight: 8 }}
              >
                Add Manual Service
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<SettingsIcon />}
                onClick={onConfigureClick}
                style={{ marginRight: 8 }}
              >
                Configure
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={onTestJaeger}
              >
                Test Jaeger
              </Button>
            </Box>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};
