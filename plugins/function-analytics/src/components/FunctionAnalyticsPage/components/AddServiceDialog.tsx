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
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@material-ui/core';
import { ManualServiceConfig, TracingBackendConfig } from '../types';

interface AddServiceDialogProps {
  open: boolean;
  onClose: () => void;
  onAddService: (service: Omit<ManualServiceConfig, 'id'>) => void;
  selectedBackend: TracingBackendConfig;
}

/**
 * Dialog for adding manual service configurations
 */
export const AddServiceDialog = ({
  open,
  onClose,
  onAddService,
  selectedBackend,
}: AddServiceDialogProps) => {
  const [newService, setNewService] = useState<Partial<ManualServiceConfig>>({
    serviceName: '',
    displayName: '',
    jaegerServiceName: '',
    environment: 'production',
    tracingBackend: selectedBackend,
    notes: '',
  });

  const handleSubmit = () => {
    if (newService.serviceName && newService.displayName) {
      onAddService(newService as Omit<ManualServiceConfig, 'id'>);
      setNewService({
        serviceName: '',
        displayName: '',
        jaegerServiceName: '',
        environment: 'production',
        tracingBackend: selectedBackend,
        notes: '',
      });
      onClose();
    }
  };

  const handleClose = () => {
    setNewService({
      serviceName: '',
      displayName: '',
      jaegerServiceName: '',
      environment: 'production',
      tracingBackend: selectedBackend,
      notes: '',
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add Manual Service</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" style={{ gap: 16 }} mt={1}>
          <TextField
            label="Service Name"
            value={newService.serviceName || ''}
            onChange={(e) => setNewService({ ...newService, serviceName: e.target.value })}
            required
            helperText="Internal service identifier"
          />
          <TextField
            label="Display Name"
            value={newService.displayName || ''}
            onChange={(e) => setNewService({ ...newService, displayName: e.target.value })}
            required
            helperText="Human-readable name"
          />
          <TextField
            label="Jaeger Service Name"
            value={newService.jaegerServiceName || ''}
            onChange={(e) => setNewService({ ...newService, jaegerServiceName: e.target.value })}
            helperText="Service name in tracing backend (optional)"
          />
          <FormControl>
            <InputLabel>Environment</InputLabel>
            <Select
              value={newService.environment || 'production'}
              onChange={(e) => setNewService({ ...newService, environment: e.target.value as string })}
            >
              <MenuItem value="development">Development</MenuItem>
              <MenuItem value="staging">Staging</MenuItem>
              <MenuItem value="production">Production</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Notes"
            value={newService.notes || ''}
            onChange={(e) => setNewService({ ...newService, notes: e.target.value })}
            multiline
            rows={2}
            helperText="Additional notes or documentation"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button 
          variant="contained" 
          color="primary"
          onClick={handleSubmit}
          disabled={!newService.serviceName || !newService.displayName}
        >
          Add Service
        </Button>
      </DialogActions>
    </Dialog>
  );
};
