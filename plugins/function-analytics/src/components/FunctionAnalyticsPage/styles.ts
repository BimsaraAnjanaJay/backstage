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

import { makeStyles } from '@material-ui/core/styles';

/**
 * Centralized styles for Function Analytics page
 * Includes table styling, risk indicators, and connection status colors
 */
export const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(2),
  },
  card: {
    marginBottom: theme.spacing(2),
  },
  metric: {
    textAlign: 'center',
    padding: theme.spacing(2),
  },
  tabPanel: {
    padding: theme.spacing(2, 0),
  },
  metricValue: {
    fontSize: '2rem',
    fontWeight: 'bold',
    color: theme.palette.primary.main,
  },
  tableContainer: {
    backgroundColor: theme.palette.background.paper,
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    '& .MuiTableHead-root': {
      backgroundColor: theme.palette.grey[100],
    },
    '& .MuiTableCell-head': {
      backgroundColor: '#1976d2',
      color: '#ffffff',
      fontWeight: 'bold',
      fontSize: '0.875rem',
      padding: theme.spacing(2),
      border: '1px solid #ffffff',
      position: 'sticky',
      top: 0,
      zIndex: 1,
    },
    '& .MuiTableCell-body': {
      color: '#212121',
      borderBottom: `1px solid ${theme.palette.divider}`,
      padding: theme.spacing(1.5),
      fontSize: '0.95rem',
      backgroundColor: 'transparent',
    },
    '& .MuiTableRow-root': {
      '&:nth-child(odd)': {
        backgroundColor: '#f7f7f7',
      },
      '&:nth-child(even)': {
        backgroundColor: '#ffffff',
      },
      '&:hover': {
        backgroundColor: '#cfe9ff !important',
        transition: 'background-color 0.15s',
      },
    },
  },
  functionCard: {
    margin: theme.spacing(1),
    padding: theme.spacing(2),
    border: '1px solid #e0e0e0',
    borderRadius: theme.spacing(1),
  },
  configSection: {
    margin: theme.spacing(2, 0),
    padding: theme.spacing(2),
    border: '1px solid #e0e0e0',
    borderRadius: theme.spacing(1),
  },
  misplacedHighRisk: {
    backgroundColor: '#f8bbd0 !important', // pink tone
    color: '#880e4f',
    fontWeight: 'bold',
    '& .MuiTableCell-body': {
      color: '#b71c1c',
      fontWeight: 'bold',
    },
    '& .MuiChip-root': {
      backgroundColor: '#e91e63 !important',
      color: '#ffffff',
    },
  },
  misplacedMediumRisk: {
    backgroundColor: '#ffe0b2 !important',
    color: '#e65100',
    fontWeight: 'bold',
    '& .MuiTableCell-body': {
      color: '#e65100',
      fontWeight: 'bold',
    },
    '& .MuiChip-root': {
      backgroundColor: '#ff9800',
      color: '#ffffff',
    },
  },
  misplacedLowRisk: {
    backgroundColor: '#fff9c4 !important',
    color: '#f57f17',
    fontWeight: 'bold',
    '& .MuiTableCell-body': {
      color: '#f57f17',
      fontWeight: 'bold',
    },
    '& .MuiChip-root': {
      backgroundColor: '#ffeb3b',
      color: '#000000',
    },
  },
  wellPlaced: {
    backgroundColor: 'inherit !important',
    color: 'inherit',
    '& .MuiTableCell-body': {
      color: theme.palette.text.primary,
    },
  },
  connectionStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    borderRadius: theme.spacing(0.5),
    fontSize: '0.875rem',
    fontWeight: 'bold',
  },
  connected: {
    backgroundColor: '#4caf50',
    color: '#ffffff',
    '& .MuiSvgIcon-root': {
      color: '#ffffff',
    },
  },
  disconnected: {
    backgroundColor: '#f44336',
    color: '#ffffff',
    '& .MuiSvgIcon-root': {
      color: '#ffffff',
    },
  },
  checking: {
    backgroundColor: '#ff9800',
    color: '#ffffff',
    '& .MuiSvgIcon-root': {
      color: '#ffffff',
    },
  },
  catalogService: {
    backgroundColor: '#e3f2fd !important',
    color: '#0d47a1',
    borderLeft: `4px solid ${theme.palette.primary.main}`,
    '&:hover': {
      backgroundColor: '#bbdefb !important',
    },
    '& .MuiTableCell-body': {
      color: '#01579b',
      backgroundColor: 'transparent',
      fontWeight: 600,
    },
  },
  manualService: {
    backgroundColor: '#fff3e0 !important',
    color: '#e65100',
    borderLeft: `4px solid ${theme.palette.secondary.main}`,
    '&:hover': {
      backgroundColor: '#ffe0b2 !important',
    },
    '& .MuiTableCell-body': {
      color: '#bf360c',
      backgroundColor: 'transparent',
      fontWeight: 600,
    },
  },
  serviceSourceChip: {
    fontSize: '0.75rem',
    height: '20px',
    fontWeight: 'bold',
  },
  selectMenuPaper: {
    backgroundColor: theme.palette.background.paper,
    color: theme.palette.text.primary,
  },
  selectMenuList: {
    backgroundColor: theme.palette.background.paper,
  },
  selectSubheader: {
    backgroundColor: theme.palette.background.default,
    color: theme.palette.text.secondary,
    fontWeight: 'bold',
    lineHeight: '48px',
    fontSize: '0.9rem',
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  selectSystemItem: {
    paddingLeft: theme.spacing(3),
    backgroundColor: theme.palette.action.hover,
    fontWeight: 500,
    '&.Mui-selected': {
      backgroundColor: theme.palette.action.selected,
    },
    '&.Mui-selected:hover': {
      backgroundColor: theme.palette.action.selected,
    },
  },
  selectServiceItem: {
    paddingLeft: theme.spacing(6),
    '&.Mui-selected': {
      backgroundColor: theme.palette.action.selected,
    },
    '&.Mui-selected:hover': {
      backgroundColor: theme.palette.action.selected,
    },
  },
}));
