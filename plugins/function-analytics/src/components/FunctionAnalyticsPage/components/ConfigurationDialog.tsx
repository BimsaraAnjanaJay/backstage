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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Divider,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Chip,
  TextField,
  CircularProgress,
} from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import DeleteIcon from '@material-ui/icons/Delete';
import CloudQueueIcon from '@material-ui/icons/CloudQueue';
import StorageIcon from '@material-ui/icons/Storage';
import {
  CatalogServiceConfig,
  ManualServiceConfig,
  TracingBackendConfig,
} from '../types';

interface ConfigurationDialogProps {
  open: boolean;
  onClose: () => void;
  catalogServices: CatalogServiceConfig[];
  manualServices: ManualServiceConfig[];
  tracingBackends: TracingBackendConfig[];
  catalogServiceCount: number;
  manualServiceCount: number;
  onRemoveManualService: (id: string) => void;
  onAddServiceClick: () => void;
  onApplyChanges: () => void;
  onRegisterRepo: (url: string) => void;
}

/**
 * Configuration dialog for managing tracing backends and services
 */
export const ConfigurationDialog = ({
  open,
  onClose,
  catalogServices,
  manualServices,
  tracingBackends,
  catalogServiceCount,
  manualServiceCount,
  onRemoveManualService,
  onAddServiceClick,
  onApplyChanges,
  onRegisterRepo,
}: ConfigurationDialogProps) => {
  const [repoUrl, setRepoUrl] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  const handleRegister = async () => {
    if (!repoUrl) return;
    setIsRegistering(true);
    try {
      await onRegisterRepo(repoUrl);
      setRepoUrl('');
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Plugin Configuration</DialogTitle>
      <DialogContent>
        <Box mb={3}>
          <Typography variant="h6" gutterBottom>
            🚀 Automatic Registration (Methodology Phase 1)
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Enter a GitHub URL to automatically clone the repository, detect
            microservices, and register them for functional tracing.
          </Typography>
          <Box display="flex" alignItems="center" style={{ gap: 12 }}>
            <TextField
              fullWidth
              variant="outlined"
              size="small"
              placeholder="https://github.com/user/repo"
              label="GitHub Repository URL"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
              disabled={isRegistering}
            />
            <Button
              variant="contained"
              color="primary"
              startIcon={
                isRegistering ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <CloudQueueIcon />
                )
              }
              onClick={handleRegister}
              disabled={isRegistering || !repoUrl}
            >
              {isRegistering ? 'Registering...' : 'Register & Discover'}
            </Button>
          </Box>
        </Box>

        <Divider />

        <Box my={3}>
          <Typography variant="h6" gutterBottom>
            Discovery Status
          </Typography>
          <Box display="flex" style={{ gap: 16 }}>
            <Chip
              icon={<CloudQueueIcon />}
              label={`Catalog: ${catalogServiceCount} services`}
              color={catalogServiceCount > 0 ? 'primary' : 'default'}
            />
            <Chip
              icon={<StorageIcon />}
              label={`Manual: ${manualServiceCount} services`}
              color={manualServiceCount > 0 ? 'secondary' : 'default'}
            />
          </Box>
        </Box>

        <Divider />

        <Box my={3}>
          <Typography variant="h6" gutterBottom>
            Tracing Backends
          </Typography>
          {tracingBackends.map((backend, index) => (
            <Card key={index} variant="outlined" style={{ marginBottom: 8 }}>
              <CardContent>
                <Box
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <Box>
                    <Typography variant="subtitle1">{backend.name}</Typography>
                    <Typography variant="body2" color="textSecondary">
                      {backend.endpoint} ({backend.type})
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
            </Card>
          ))}
          <Button variant="outlined" startIcon={<AddIcon />} disabled>
            Add Backend
          </Button>
        </Box>

        <Divider />

        <Box mt={3}>
          <Typography variant="h6" gutterBottom>
            Catalog Services ({catalogServices.length})
          </Typography>
          <List dense>
            {catalogServices.map((service, index) => (
              <ListItem key={index}>
                <ListItemIcon>
                  <CloudQueueIcon color="primary" />
                </ListItemIcon>
                <ListItemText
                  primary={service.serviceName}
                  secondary={`Owner: ${service.owner || 'Unknown'} • ${
                    service.environment
                  }`}
                />
              </ListItem>
            ))}
          </List>
        </Box>

        <Divider style={{ marginTop: 16 }} />

        <Box mt={3}>
          <Typography variant="h6" gutterBottom>
            Manual Services ({manualServices.length})
          </Typography>
          <List>
            {manualServices.map(service => (
              <ListItem key={service.id}>
                <ListItemIcon>
                  <StorageIcon />
                </ListItemIcon>
                <ListItemText
                  primary={service.displayName}
                  secondary={`${service.tracingBackend.name} • ${
                    service.environment || 'unknown'
                  }`}
                />
                <IconButton onClick={() => onRemoveManualService(service.id)}>
                  <DeleteIcon />
                </IconButton>
              </ListItem>
            ))}
          </List>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={onAddServiceClick}
          >
            Add Manual Service
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" color="primary" onClick={onApplyChanges}>
          Apply Changes
        </Button>
      </DialogActions>
    </Dialog>
  );
};
