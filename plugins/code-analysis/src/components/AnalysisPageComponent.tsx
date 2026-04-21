// plugins/code-analysis/src/components/AnalysisPageComponent.tsx

import React, { useState, useEffect, useRef } from 'react';
import {
  Content,
  Header,
  Page,
  InfoCard,
  Progress,
  ErrorPanel,
} from '@backstage/core-components';
import { useApi, identityApiRef, githubAuthApiRef } from '@backstage/core-plugin-api';
import { useTheme } from '@material-ui/core/styles';
import {
  Button,
  Grid,
  Typography,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Divider,
  Paper,
  Box,
  Slider,
  // ── CHANGE 1: added Dialog imports ───────────────────────────────
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
} from '@material-ui/core';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import CloseIcon from '@material-ui/icons/Close';
import jsPDF from 'jspdf';
import FolderIcon from '@material-ui/icons/Folder';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import { codeAnalysisApiRef, AnalysisResult } from '../api';

const BASE_URL = 'http://localhost:7007/api/code-analysis-backend';

// ── Types ──────────────────────────────────────────────────────────────────

interface Project {
  name:        string;
  description: string;
  services:    string[];
}

interface Recommendation {
  urgency:       'HIGH' | 'MEDIUM' | 'LOW';
  action:        'VIEW' | 'VIEW' | 'VIEW';
  detail:        string;
  same_language: boolean;
}

interface ClonePair {
  score:          number;
  confidence:     'HIGH' | 'MEDIUM' | 'LOW';
  is_clone:       boolean;
  function_1:     string;
  service_1:      string;
  lang_1:         string;
  location_1:     { start: number; end: number };
  function_2:     string;
  service_2:      string;
  lang_2:         string;
  location_2:     { start: number; end: number };
  lang_pair:      string;
  recommendation: Recommendation | null;
  code_1?:         string;
  code_2?:         string;
}

interface CloneReport {
  catalog_summary?: {
    services_analysed:   number;
    service_names:       string[];
    total_files_fetched: number;
  };
  summary: {
    services_analysed:   number;
    service_names:       string[];
    functions_processed: number;
    functions_sliced:    number;
    cross_service_pairs: number;
    clones_detected:     number;
  };
  clone_pairs: ClonePair[];
  top_pairs:   ClonePair[];
  meta:        { processing_time_sec: number };
}

// ── CHANGE 2: type for the View modal ─────────────────────────────────────
interface ViewModalState {
  open:   boolean;
  pair:   ClonePair | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const actionLabel = (a: string) => {
  if (a === 'REMOVE_DUPLICATE') return '👁 View';
  if (a === 'REVIEW_AND_MERGE') return '👁 View';
  return '👁 View';
};

interface GraphNode {
  id: string;
  x: number;
  y: number;
}

interface GraphEdge {
  source: string;
  target: string;
  score: number;
  count: number;
}

const buildCloneGraph = (report: CloneReport): { nodes: GraphNode[]; edges: GraphEdge[] } => {
  const services = Array.from(
    new Set(report.clone_pairs.flatMap(pair => [pair.service_1, pair.service_2])),
  );

  const width = 700;
  const height = 340;
  const radius = Math.min(width, height) / 2 - 80;
  const centerX = width / 2;
  const centerY = height / 2;

  const nodes = services.map((service, index) => {
    const angle = services.length > 0
      ? (index / services.length) * Math.PI * 2
      : 0;
    return {
      id: service,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });

  const edgeMap = new Map<string, GraphEdge>();

  for (const pair of report.clone_pairs) {
    const source = pair.service_1;
    const target = pair.service_2;
    const key = source < target ? `${source}::${target}` : `${target}::${source}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.score = Math.max(existing.score, pair.score);
    } else {
      edgeMap.set(key, {
        source,
        target,
        score: pair.score,
        count: 1,
      });
    }
  }

  return { nodes, edges: Array.from(edgeMap.values()) };
};

// ── Component ──────────────────────────────────────────────────────────────

export const AnalysisPageComponent = () => {
  const theme = useTheme();

  const getScoreColor = (score: number) => {
    if (score >= 0.95) return theme.palette.error.main;
    if (score >= 0.90) return theme.palette.warning.main;
    if (score >= 0.85) return theme.palette.warning.light;
    return theme.palette.success.main;
  };

  const getUrgencyColor = (u: string): 'default' | 'primary' | 'secondary' =>
    u === 'HIGH' ? 'secondary' : u === 'MEDIUM' ? 'primary' : 'default';

  const DEFAULT_THRESHOLD = 0.85;

  // ── Single-service state (existing, unchanged) ────────────────────────────
  const [entityRef, setEntityRef] = useState('component:default/backstage');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<Error | null>(null);
  const [results,   setResults]   = useState<AnalysisResult | null>(null);

  // ── Clone detection state ─────────────────────────────────────────────────
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);

  // ── Project-level state ───────────────────────────────────────────────────
  const [projects,        setProjects]        = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedServices,setSelectedServices]= useState<Set<string>>(new Set());
  const [selectedSource, setSelectedSource]   = useState<'catalog' | 'github' | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // ── Clone detection state ─────────────────────────────────────────────────
  const [allLoading, setAllLoading] = useState(false);
  const [allError,   setAllError]   = useState<string | null>(null);
  const [allReport,  setAllReport]  = useState<CloneReport | null>(null);
  const [githubRepos, setGithubRepos] = useState<Array<{ full_name: string; html_url: string; description?: string }>>([]);
  const [selectedGithubRepos, setSelectedGithubRepos] = useState<Set<string>>(new Set());
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── CHANGE 3: state for the View modal ───────────────────────────────────
  const [viewModal, setViewModal] = useState<ViewModalState>({ open: false, pair: null });

  const openViewModal  = (pair: ClonePair) => setViewModal({ open: true, pair });
  const closeViewModal = ()                => setViewModal({ open: false, pair: null });

  const filteredReport = allReport && {
    ...allReport,
    clone_pairs: allReport.clone_pairs.filter(pair => pair.score >= threshold),
    top_pairs: allReport.top_pairs.filter(pair => pair.score >= threshold),
  };

  const previewReport = filteredReport ?? allReport;

  const codeAnalysisApi = useApi(codeAnalysisApiRef);
  const identityApi     = useApi(identityApiRef);
  const githubAuthApi   = useApi(githubAuthApiRef);

  // ── Load projects on mount ────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setProjectsLoading(true);
      try {
        const { token } = await identityApi.getCredentials();
        const resp = await fetch(`${BASE_URL}/list-projects`, {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (resp.ok) {
          const data = await resp.json();
          setProjects(data.projects ?? []);
        }
      } catch {
        // silently ignore
      } finally {
        setProjectsLoading(false);
      }
    };
    load();
  }, []);

  // ── Select a project → pre-select all its services ───────────────────────
  const handleSelectProject = (project: Project) => {
    setSelectedSource('catalog');
    setSelectedProject(project);
    setSelectedServices(new Set(project.services));
    setSelectedGithubRepos(new Set());
    setGithubRepos([]);
    setGithubError(null);
    setAllReport(null);
    setAllError(null);
  };

  // ── Service checkbox helpers ──────────────────────────────────────────────
  const toggleService = (name: string) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };
  const selectAll   = () => selectedProject && setSelectedServices(new Set(selectedProject.services));
  const deselectAll = () => setSelectedServices(new Set());

  const toggleGithubRepo = (fullName: string) => {
    setSelectedGithubRepos(prev => {
      const next = new Set(prev);
      next.has(fullName) ? next.delete(fullName) : next.add(fullName);
      return next;
    });
  };

  const handleLoadGithubRepos = async () => {
    setSelectedSource('github');
    setSelectedProject(null);
    setSelectedServices(new Set());
    setGithubLoading(true);
    setGithubError(null);
    setAllError(null);
    try {
      const token = await githubAuthApi.getAccessToken(['repo']);
      const resp = await fetch('https://api.github.com/user/repos?visibility=all&per_page=100', {
        headers: {
          Authorization: `token ${token}`,
        },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub repo fetch failed: ${resp.status} ${text}`);
      }
      const data = await resp.json();
      setGithubRepos(data.map((repo: any) => ({
        full_name: repo.full_name,
        html_url: repo.html_url,
        description: repo.description,
      })));
    } catch (e: any) {
      setGithubError(e.message || 'Unable to load GitHub repositories.');
    } finally {
      setGithubLoading(false);
    }
  };

  // ── Existing single-service handler (unchanged) ──────────────────────────
  const handleAnalyze = () => {
    setLoading(true);
    setError(null);
    setResults(null);
    codeAnalysisApi
      .analyzeEntity(entityRef)
      .then(data => setResults(data))
      .catch(e => setError(e))
      .finally(() => setLoading(false));
  };

  // ── Clone detection handler ───────────────────────────────────────────────
  const handleDetectClones = async () => {
    const useGithubRepos = selectedGithubRepos.size > 0;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setAllLoading(true);
    setAllError(null);
    setAllReport(null);

    try {
      const { token } = await identityApi.getCredentials();
      const endpoint = useGithubRepos ? `${BASE_URL}/analyze-repos` : `${BASE_URL}/analyze-all`;
      const body = useGithubRepos
        ? { threshold, repositories: Array.from(selectedGithubRepos) }
        : { threshold, selected_services: Array.from(selectedServices) };

      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${resp.status} ${text}`);
      }
      setAllReport(await resp.json());
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setAllError('Clone detection cancelled.');
      } else {
        setAllError(e.message);
      }
    } finally {
      setAllLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelDetectClones = () => {
    if (!abortControllerRef.current) {
      return;
    }
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    setAllLoading(false);
    setAllReport(null);
    setAllError('Clone detection cancelled.');
  };

  // ── Export functionality ──────────────────────────────────────────────────
  const handleExportReport = () => {
    if (!allReport || !previewReport) return;

    const doc = new jsPDF();
    const timestamp = new Date().toISOString().split('T')[0];
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let yPosition = 20;

    const addText = (text: string, fontSize = 10, isBold = false) => {
      if (isBold) doc.setFont('helvetica', 'bold');
      else doc.setFont('helvetica', 'normal');
      doc.setFontSize(fontSize);

      const lines = doc.splitTextToSize(text, pageWidth - 40);
      const lineHeight = fontSize * 0.5;

      lines.forEach((line: string) => {
        if (yPosition + lineHeight > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
        }
        doc.text(line, 20, yPosition);
        yPosition += lineHeight;
      });
    };

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Clone Detection Report', pageWidth / 2, yPosition, { align: 'center' });
    yPosition += 15;

    addText(`Generated: ${new Date().toLocaleString()}`, 10);
    addText(`Threshold: ${(threshold * 100).toFixed(0)}%`, 10);
    addText(`Source Type: ${selectedGithubRepos.size > 0 ? 'GitHub Repositories' : 'Catalog Services'}`, 10);
    yPosition += 10;

    const sources = selectedGithubRepos.size > 0
      ? Array.from(selectedGithubRepos)
      : Array.from(selectedServices);
    addText(`Sources: ${sources.join(', ')}`, 10);
    yPosition += 15;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Summary', 20, yPosition);
    yPosition += 10;

    const summaryData = [
      ['Services Analyzed', allReport.summary?.services_analysed?.toString() || '0'],
      ['Functions Processed', allReport.summary?.functions_processed?.toString() || '0'],
      ['Functions Sliced', allReport.summary?.functions_sliced?.toString() || '0'],
      ['Pairs Checked', allReport.summary?.cross_service_pairs?.toString() || '0'],
      ['Clones Found', (previewReport.clone_pairs?.length ?? 0).toString()],
      ['Processing Time', `${allReport.meta?.processing_time_sec || 0}s`]
    ];

    summaryData.forEach(([label, value]) => {
      addText(`${label}: ${value}`, 10);
    });

    yPosition += 15;

    if (previewReport.clone_pairs && previewReport.clone_pairs.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text('Detected Clone Pairs', 20, yPosition);
      yPosition += 10;

      previewReport.clone_pairs.forEach((pair, index) => {
        if (yPosition > pageHeight - 60) {
          doc.addPage();
          yPosition = 20;
        }

        addText(`Pair ${index + 1}:`, 11, true);
        addText(`Score: ${(pair.score * 100).toFixed(1)}% (${pair.confidence})`, 9);
        addText(`Function 1: ${pair.function_1} (${pair.service_1})`, 9);
        addText(`Function 2: ${pair.function_2} (${pair.service_2})`, 9);
        addText(`Languages: ${pair.lang_1} ↔ ${pair.lang_2}`, 9);

        if (pair.recommendation) {
          addText(`Recommendation: ${pair.recommendation.action} (${pair.recommendation.urgency})`, 9);
          if (pair.recommendation.detail) {
            addText(`Details: ${pair.recommendation.detail}`, 9);
          }
        }

        yPosition += 8;
      });
    } else {
      addText('No clone pairs detected with current threshold.', 10);
    }

    const filename = `clone-detection-report-${timestamp}.pdf`;
    doc.save(filename);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Page themeId="tool">
      <Header title="Cross-Service Clone Detection" />
      <Content>
        <Grid container spacing={3} direction="column">

          {loading && <Grid item><Progress /></Grid>}
          {error   && <Grid item><ErrorPanel error={error} /></Grid>}
          {results && (
            <Grid item>
              <InfoCard title="Fetched Files">
                <pre style={{ fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
                  {JSON.stringify(results, null, 2)}
                </pre>
              </InfoCard>
            </Grid>
          )}

          {/* ── SECTION 2: Clone detection — project-first flow ── */}
          <Grid item>
            <InfoCard title="Cross-Service Clone Detection">

              <Typography variant="body2" color="textSecondary" gutterBottom>
                Select a project, then choose which services to compare.
                Backstage fetches source code from GitHub and runs
                GraphCodeBERT semantic analysis automatically.
              </Typography>

              <Divider style={{ margin: '12px 0' }} />

              {/* ── STEP 1: Project selection ── */}
              <Typography variant="subtitle2" gutterBottom>
                Step 1 — Select a Project
              </Typography>

              {projectsLoading && <Progress />}

              {!projectsLoading && projects.length === 0 && (
                <Typography variant="body2" color="textSecondary">
                  No projects found. Make sure your catalog YAML includes a{' '}
                  <code>kind: System</code> entity and each Component has{' '}
                  <code>spec.system</code> set.
                </Typography>
              )}

              {projects.length > 0 && (
                <Box display="flex" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                  {projects.map(project => {
                    const isSelected = selectedProject?.name === project.name;
                    return (
                      <Paper
                        key={project.name}
                        elevation={isSelected ? 4 : 1}
                        onClick={() => !allLoading && handleSelectProject(project)}
                        style={{
                          padding: '14px 20px',
                          cursor: allLoading ? 'not-allowed' : 'pointer',
                          minWidth: 200,
                          border: `1px solid ${isSelected ? theme.palette.primary.main : theme.palette.divider}`,
                          backgroundColor: isSelected ? theme.palette.action.selected : theme.palette.background.paper,
                          borderRadius: theme.shape.borderRadius,
                          transition: 'all 0.15s',
                          opacity: allLoading ? 0.5 : 1,
                        }}
                      >
                        <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                          {isSelected
                            ? <CheckCircleIcon style={{ color: theme.palette.primary.main, fontSize: 20 }} />
                            : <FolderIcon style={{ color: theme.palette.text.secondary, fontSize: 20 }} />
                          }
                          <Box>
                            <Typography variant="subtitle2" style={{ fontWeight: 'bold' }}>
                              {project.name}
                            </Typography>
                            <Typography variant="caption" color="textSecondary">
                              {project.services.length} service{project.services.length !== 1 ? 's' : ''}
                            </Typography>
                            {project.description && (
                              <Typography variant="caption" color="textSecondary" display="block">
                                {project.description}
                              </Typography>
                            )}
                          </Box>
                        </Box>
                      </Paper>
                    );
                  })}

                  <Paper
                    key="github-repos"
                    elevation={selectedSource === 'github' ? 4 : 1}
                    onClick={handleLoadGithubRepos}
                    style={{
                      padding: '14px 20px',
                      cursor: allLoading ? 'not-allowed' : 'pointer',
                      minWidth: 200,
                      border: `1px solid ${selectedSource === 'github' ? theme.palette.primary.main : theme.palette.divider}`,
                      backgroundColor: selectedSource === 'github'
                        ? theme.palette.action.selected
                        : theme.palette.background.paper,
                      borderRadius: theme.shape.borderRadius,
                      transition: 'all 0.15s',
                      opacity: allLoading ? 0.5 : 1,
                    }}
                  >
                    <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                      <FolderIcon style={{ color: theme.palette.text.secondary, fontSize: 20 }} />
                      <Box>
                        <Typography variant="subtitle2" style={{ fontWeight: 'bold' }}>
                          GitHub Repositories
                        </Typography>
                        <Typography variant="caption" color="textSecondary" display="block">
                          Load repos from your authenticated GitHub account.
                        </Typography>
                        {selectedGithubRepos.size > 0 && (
                          <Typography variant="caption" color="textSecondary" display="block">
                            {selectedGithubRepos.size} selected repository{selectedGithubRepos.size !== 1 ? 'ies' : ''}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  </Paper>
                </Box>
              )}

              {githubError && (
                <Typography variant="caption" style={{ color: theme.palette.error.main, display: 'block', marginTop: 8 }}>
                  {githubError}
                </Typography>
              )}

              {githubRepos.length > 0 && selectedSource === 'github' && (
                <Box mb={3}>
                  <Typography variant="subtitle2" gutterBottom>
                    Step 2 — Select GitHub repositories
                  </Typography>
                  <Box display="flex" alignItems="center" style={{ gap: 12, flexWrap: 'wrap' }}>
                    <Button
                      variant="outlined"
                      color="primary"
                      onClick={handleLoadGithubRepos}
                      disabled={githubLoading}
                    >
                      {githubLoading ? 'Loading repos…' : 'Refresh GitHub repos'}
                    </Button>
                    {selectedGithubRepos.size > 0 && (
                      <Typography variant="caption" color="textSecondary">
                        {selectedGithubRepos.size} selected GitHub repo{selectedGithubRepos.size !== 1 ? 's' : ''}
                      </Typography>
                    )}
                  </Box>

                  <Box mt={2} style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: 12 }}>
                    {githubRepos.map(repo => (
                      <FormControlLabel
                        key={repo.full_name}
                        control={
                          <Checkbox
                            checked={selectedGithubRepos.has(repo.full_name)}
                            onChange={() => toggleGithubRepo(repo.full_name)}
                            color="primary"
                            size="small"
                            disabled={allLoading}
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2" component="span">
                              <strong>{repo.full_name}</strong>
                            </Typography>
                            <Typography variant="caption" color="textSecondary" component="div">
                              {repo.description || 'No description'}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </Box>

                  <Divider style={{ margin: '12px 0' }} />

                  <Typography variant="subtitle2" gutterBottom>
                    Step 3 — Configure &amp; Run
                  </Typography>

                  <Box display="flex" alignItems="center" style={{ gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                    <Typography variant="body2" color="textSecondary">
                      Run clone detection once, then adjust the threshold below the graph.
                    </Typography>
                    <Button
                      variant="contained"
                      color="primary"
                      onClick={handleDetectClones}
                      disabled={allLoading || selectedGithubRepos.size < 2}
                      style={{ height: 40 }}
                    >
                      {allLoading ? 'Analyzing…' : '🔍 Detect Clones'}
                    </Button>
                    {allLoading && (
                      <Button
                        variant="outlined"
                        color="secondary"
                        onClick={handleCancelDetectClones}
                        style={{ height: 40 }}
                      >
                        Cancel
                      </Button>
                    )}
                  </Box>

                  {allLoading && (
                    <>
                      <Progress />
                      <Typography variant="caption" color="textSecondary">
                        Fetching source code from GitHub and running GraphCodeBERT analysis…
                        This may take few minutes on first run.
                      </Typography>
                    </>
                  )}

                  {allError && (
                    <Typography style={{ color: 'red', marginTop: 8 }}>
                      ⚠ {allError}
                    </Typography>
                  )}
                </Box>
              )}

              {/* ── STEP 2: Service selection (shown only after project selected) ── */}
              {selectedProject && (
                <>
                  <Divider style={{ margin: '12px 0' }} />

                  <Typography variant="subtitle2" gutterBottom>
                    Step 2 — Select Services from{' '}
                    <strong>{selectedProject.name}</strong>
                  </Typography>

                  <Box mb={1}>
                    <Button
                      size="small"
                      onClick={selectAll}
                      disabled={selectedGithubRepos.size > 0}
                    >
                      Select All
                    </Button>
                    <Button
                      size="small"
                      onClick={deselectAll}
                      style={{ marginLeft: 8 }}
                      disabled={selectedGithubRepos.size > 0}
                    >
                      Clear All
                    </Button>
                    <Typography
                      variant="caption"
                      color="textSecondary"
                      style={{ marginLeft: 12 }}
                    >
                      {selectedServices.size} of {selectedProject.services.length} selected
                    </Typography>
                  </Box>

                  {selectedGithubRepos.size > 0 && (
                    <Typography variant="caption" color="textSecondary" style={{ display: 'block', marginBottom: 8 }}>
                      GitHub repo selection is active — catalog service selection is disabled.
                    </Typography>
                  )}

                  <FormGroup row>
                    {selectedProject.services.map(name => (
                      <FormControlLabel
                        key={name}
                        control={
                          <Checkbox
                            checked={selectedServices.has(name)}
                            onChange={() => toggleService(name)}
                            color="primary"
                            size="small"
                            disabled={selectedGithubRepos.size > 0 || allLoading}
                          />
                        }
                        label={name}
                      />
                    ))}
                  </FormGroup>

                  <Divider style={{ margin: '12px 0' }} />

                  {/* ── STEP 3: Configure & Run ── */}
                  <Typography variant="subtitle2" gutterBottom>
                    Step 3 — Configure &amp; Run
                  </Typography>

                  <Box display="flex" alignItems="center" style={{ gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                    <Typography variant="body2" color="textSecondary">
                      Run clone detection once, then adjust the threshold below the graph.
                    </Typography>
                    <Button
                      variant="contained"
                      color="primary"
                      onClick={handleDetectClones}
                      disabled={allLoading || (selectedGithubRepos.size < 1 && selectedServices.size < 1)}
                      style={{ height: 40 }}
                    >
                      {allLoading ? 'Analyzing…' : '🔍 Detect Clones'}
                    </Button>
                    {allLoading && (
                      <Button
                        variant="outlined"
                        color="secondary"
                        onClick={handleCancelDetectClones}
                        style={{ height: 40 }}
                      >
                        Cancel
                      </Button>
                    )}
                  </Box>

                  {allLoading && (
                    <>
                      <Progress />
                      <Typography variant="caption" color="textSecondary">
                        Fetching source code from GitHub and running GraphCodeBERT analysis…
                        This may take few minutes on first run.
                      </Typography>
                    </>
                  )}

                  {allError && (
                    <Typography style={{ color: 'red', marginTop: 8 }}>
                      ⚠ {allError}
                    </Typography>
                  )}
                </>
              )}

              {/* ── RESULTS ── */}
              {allReport && (
                <Box mt={2}>

                  {/* Summary strip */}
                  <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
                    {[
                      { label: 'Services',      value: allReport.summary?.services_analysed },
                      { label: 'Functions',     value: allReport.summary?.functions_processed },
                      { label: 'Sliced',        value: allReport.summary?.functions_sliced },
                      { label: 'Pairs Checked', value: allReport.summary?.cross_service_pairs },
                      { label: 'Clones Found',  value: previewReport.clone_pairs?.length ?? 0, hi: true },
                      { label: 'Time',          value: `${allReport.meta?.processing_time_sec}s` },
                    ].map(c => (
                      <Paper
                        key={c.label}
                        elevation={1}
                        style={{ padding: '10px 20px', textAlign: 'center', minWidth: 90 }}
                      >
                        <Typography
                          variant="h5"
                          style={{
                            color: (c as any).hi && (c.value as number) > 0
                              ? theme.palette.error.main : theme.palette.text.primary,
                          }}
                        >
                          {c.value ?? '—'}
                        </Typography>
                        <Typography variant="caption" color="textSecondary">
                          {c.label}
                        </Typography>
                      </Paper>
                    ))}
                  </Box>

                  {/* Export button */}
                  <Box mb={3} display="flex" justifyContent="flex-end">
                    <Button
                      variant="outlined"
                      color="primary"
                      onClick={handleExportReport}
                      startIcon={<span>📄</span>}
                      disabled={!previewReport || !previewReport.clone_pairs || previewReport.clone_pairs.length === 0}
                    >
                      Export PDF Report
                    </Button>
                  </Box>

                  {/* Clone graph */}
                  <Box mb={3}>
                    <Typography variant="subtitle1" gutterBottom>
                      <strong>Clone Graph</strong>
                    </Typography>
                    <Typography variant="body2" color="textSecondary" gutterBottom>
                      Services are shown as nodes and clone relationships are shown as edges.
                      Thicker lines indicate more clone pairs; color reflects the highest similarity score.
                    </Typography>
                    <Box style={{ maxWidth: 420, marginBottom: 16 }}>
                      <Typography gutterBottom>
                        Threshold: <strong>{(threshold * 100).toFixed(0)}%</strong>
                      </Typography>
                      <Slider
                        value={threshold}
                        min={0.5}
                        max={1}
                        step={0.01}
                        onChange={(_event, value) => setThreshold(value as number)}
                        valueLabelDisplay="auto"
                        aria-labelledby="clone-threshold-slider"
                      />
                    </Box>
                    <Box
                      style={{
                        overflowX: 'auto',
                        padding: 12,
                        backgroundColor: theme.palette.background.paper,
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: theme.shape.borderRadius,
                      }}
                    >
                      <svg
                        width="100%"
                        viewBox="0 0 700 340"
                        style={{ display: 'block', minWidth: 700, height: 340 }}
                      >
                        {(() => {
                          const graph = buildCloneGraph(previewReport!);
                          return (
                            <>
                              {graph.edges.map((edge, index) => {
                                const source = graph.nodes.find(node => node.id === edge.source);
                                const target = graph.nodes.find(node => node.id === edge.target);
                                if (!source || !target) return null;
                                const lineWidth = Math.max(1, Math.min(6, edge.count));
                                return (
                                  <g key={`${edge.source}-${edge.target}-${index}`}>
                                    <line
                                      x1={source.x}
                                      y1={source.y}
                                      x2={target.x}
                                      y2={target.y}
                                      stroke={getScoreColor(edge.score)}
                                      strokeWidth={lineWidth}
                                      opacity={0.75}
                                      style={{ transition: 'stroke 0.2s ease, stroke-width 0.2s ease, opacity 0.2s ease' }}
                                    />
                                  </g>
                                );
                              })}

                              {graph.nodes.map(node => {
                                const nodeWidth = 140;
                                const nodeHeight = 38;
                                return (
                                  <g key={node.id}>
                                    <rect
                                      x={node.x - nodeWidth / 2}
                                      y={node.y - nodeHeight / 2}
                                      width={nodeWidth}
                                      height={nodeHeight}
                                      rx={10}
                                      fill={theme.palette.background.default}
                                      stroke={theme.palette.primary.main}
                                      strokeWidth={2}
                                      style={{ transition: 'stroke 0.2s ease, fill 0.2s ease' }}
                                    />
                                    <text
                                      x={node.x}
                                      y={node.y + 5}
                                      textAnchor="middle"
                                      fontSize="11"
                                      fill={theme.palette.text.primary}
                                      textLength={nodeWidth - 16}
                                      lengthAdjust="spacingAndGlyphs"
                                    >
                                      {node.id}
                                    </text>
                                  </g>
                                );
                              })}
                            </>
                          );
                        })()}
                      </svg>
                    </Box>
                  </Box>

                  {/* Clone pairs */}
                  <Typography variant="subtitle1" gutterBottom>
                    <strong>Detected Clone Pairs ({previewReport.clone_pairs?.length ?? 0})</strong>
                  </Typography>

                  {previewReport.clone_pairs?.length === 0 && (
                    <Typography variant="body2" color="textSecondary">
                      ✓ No semantic clones detected above threshold {(threshold * 100).toFixed(0)}%.
                    </Typography>
                  )}

                  {previewReport.clone_pairs?.map((pair, i) => (
                    <Accordion key={i} style={{ marginBottom: 6 }}>
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Box display="flex" alignItems="center" style={{ gap: 10, width: '100%' }}>
                          <Chip
                            label={pair.score?.toFixed(4)}
                            size="small"
                            style={{
                              backgroundColor: getScoreColor(pair.score),
                              color: theme.palette.getContrastText(getScoreColor(pair.score)),
                              fontWeight: 'bold',
                              minWidth: 76,
                            }}
                          />
                          <Chip
                            label={pair.confidence}
                            size="small"
                            color={getUrgencyColor(pair.confidence)}
                          />
                          <Chip label={pair.lang_pair} size="small" variant="outlined" />
                          {pair.recommendation && (
                            <Chip
                              label={actionLabel(pair.recommendation.action)}
                              size="small"
                              color={getUrgencyColor(pair.recommendation.urgency)}
                              variant="outlined"
                            />
                          )}
                          <Typography variant="body2" style={{ flex: 1 }}>
                            <strong>{pair.service_1}</strong>
                            {' ↔ '}
                            <strong>{pair.service_2}</strong>
                          </Typography>
                        </Box>
                      </AccordionSummary>

                      <AccordionDetails>
                        <Grid container spacing={2}>
                          <Grid item xs={12} sm={5}>
                            <Typography variant="subtitle2" color="primary" gutterBottom>
                              Function 1
                            </Typography>
                            <Typography variant="body2"><strong>Service:</strong> {pair.service_1}</Typography>
                            <Typography variant="body2">
                              <strong>Function:</strong>{' '}
                              <code>{pair.function_1?.split('::')[1]}</code>
                            </Typography>
                            <Typography variant="body2">
                              <strong>File:</strong>{' '}
                              {pair.function_1?.split('::')[0]?.replace(`${pair.service_1}/`, '')}
                            </Typography>
                            <Typography variant="body2">
                              <strong>Lines:</strong> {pair.location_1?.start}–{pair.location_1?.end}
                            </Typography>
                            <Typography variant="body2"><strong>Language:</strong> {pair.lang_1}</Typography>
                          </Grid>

                          <Grid item xs={12} sm={5}>
                            <Typography variant="subtitle2" color="secondary" gutterBottom>
                              Function 2
                            </Typography>
                            <Typography variant="body2"><strong>Service:</strong> {pair.service_2}</Typography>
                            <Typography variant="body2">
                              <strong>Function:</strong>{' '}
                              <code>{pair.function_2?.split('::')[1]}</code>
                            </Typography>
                            <Typography variant="body2">
                              <strong>File:</strong>{' '}
                              {pair.function_2?.split('::')[0]?.replace(`${pair.service_2}/`, '')}
                            </Typography>
                            <Typography variant="body2">
                              <strong>Lines:</strong> {pair.location_2?.start}–{pair.location_2?.end}
                            </Typography>
                            <Typography variant="body2"><strong>Language:</strong> {pair.lang_2}</Typography>
                          </Grid>

                          {pair.recommendation && (
                            <Grid item xs={12}>
                              <Paper
                                variant="outlined"
                                style={{
                                  padding: 12,
                                  backgroundColor: theme.palette.background.default,
                                  borderLeft: `4px solid ${
                                    pair.recommendation.urgency === 'HIGH' ? theme.palette.error.main :
                                    pair.recommendation.urgency === 'MEDIUM' ? theme.palette.warning.main :
                                    theme.palette.success.main
                                  }`,
                                }}
                              >
                                <Typography variant="subtitle2" gutterBottom color="textPrimary">
                                  💡 Refactoring Recommendation
                                </Typography>
                                <Box display="flex" style={{ gap: 8, marginBottom: 8 }}>
                                  <Chip
                                    label={`Urgency: ${pair.recommendation.urgency}`}
                                    size="small"
                                    color={getUrgencyColor(pair.recommendation.urgency)}
                                  />
                                  {/* ── CHANGE 4: View chip is now clickable ── */}
                                  <Chip
                                    label={actionLabel(pair.recommendation.action)}
                                    size="small"
                                    variant="outlined"
                                    clickable
                                    onClick={() => openViewModal(pair)}
                                  />
                                  <Chip
                                    label={pair.recommendation.same_language ? 'Same Language' : 'Cross Language'}
                                    size="small"
                                    variant="outlined"
                                  />
                                </Box>
                                <Typography variant="body2">
                                  {pair.recommendation.detail}
                                </Typography>
                              </Paper>
                            </Grid>
                          )}
                        </Grid>
                      </AccordionDetails>
                    </Accordion>
                  ))}

                  {/* All pairs table */}
                  {previewReport.top_pairs?.length > 0 && (
                    <Box mt={3}>
                      <Typography variant="subtitle2" gutterBottom>
                        All Cross-Service Pairs (top 30 by score)
                      </Typography>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ backgroundColor: theme.palette.background.default, borderBottom: `2px solid ${theme.palette.divider}` }}>
                            <th style={{ padding: '6px 8px', textAlign: 'left', color: theme.palette.text.primary }}>Score</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', color: theme.palette.text.primary }}>Lang</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', color: theme.palette.text.primary }}>Function 1</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', color: theme.palette.text.primary }}>Function 2</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', color: theme.palette.text.primary }}>Clone?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewReport.top_pairs.slice(0, 30).map((pair, i) => (
                            <tr
                              key={i}
                              style={{
                                backgroundColor: pair.is_clone ? theme.palette.action.hover : undefined,
                                borderBottom: `1px solid ${theme.palette.divider}`,
                              }}
                            >
                              <td style={{ padding: '4px 8px', fontWeight: 'bold', color: getScoreColor(pair.score) }}>
                                {pair.score?.toFixed(4)}
                              </td>
                              <td style={{ padding: '4px 8px', color: theme.palette.text.primary }}>
                                <code>{pair.lang_pair}</code>
                              </td>
                              <td style={{ padding: '4px 8px', color: theme.palette.text.primary }}>
                                <strong>{pair.service_1}</strong><br />
                                <code style={{ fontSize: 11, color: theme.palette.text.secondary }}>{pair.function_1?.split('::')[1]}</code>
                              </td>
                              <td style={{ padding: '4px 8px', color: theme.palette.text.primary }}>
                                <strong>{pair.service_2}</strong><br />
                                <code style={{ fontSize: 11, color: theme.palette.text.secondary }}>{pair.function_2?.split('::')[1]}</code>
                              </td>
                              <td style={{ padding: '4px 8px' }}>
                                {pair.is_clone
                                  ? <Chip label="CLONE" size="small" color="secondary" variant="outlined" />
                                  : <span style={{ color: theme.palette.text.disabled }}>—</span>
                                }
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Box>
                  )}
                </Box>
              )}

            </InfoCard>
          </Grid>

        </Grid>
      </Content>

      {/* ── CHANGE 5: View modal — shows both function source locations ── */}
      <Dialog
        open={viewModal.open}
        onClose={closeViewModal}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">
              Detected Clone Functions
            </Typography>
            <IconButton size="small" onClick={closeViewModal}>
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>

        <DialogContent dividers>
          {viewModal.pair && (
            <Grid container spacing={3}>

              {/* Score banner */}
              <Grid item xs={12}>
                <Box
                  display="flex"
                  alignItems="center"
                  style={{ gap: 10, marginBottom: 4 }}
                >
                  <Chip
                    label={`Similarity: ${(viewModal.pair.score * 100).toFixed(1)}%`}
                    style={{
                      backgroundColor: getScoreColor(viewModal.pair.score),
                      color: theme.palette.getContrastText(getScoreColor(viewModal.pair.score)),
                      fontWeight: 'bold',
                    }}
                  />
                  <Chip
                    label={viewModal.pair.lang_pair}
                    variant="outlined"
                    size="small"
                  />
                  <Chip
                    label={viewModal.pair.recommendation?.same_language ? 'Same Language' : 'Cross Language'}
                    variant="outlined"
                    size="small"
                  />
                </Box>
                <Divider />
              </Grid>

              {/* Function 1 */}
              <Grid item xs={12} md={6}>
                <Box
                  style={{
                    border: `2px solid ${theme.palette.primary.main}`,
                    borderRadius: theme.shape.borderRadius,
                    overflow: 'hidden',
                  }}
                >
                  {/* Header */}
                  <Box
                    style={{
                      backgroundColor: theme.palette.primary.main,
                      padding: '8px 12px',
                    }}
                  >
                    <Typography
                      variant="subtitle2"
                      style={{ color: theme.palette.primary.contrastText, fontWeight: 'bold' }}
                    >
                      Function 1
                    </Typography>
                    <Typography
                      variant="caption"
                      style={{ color: theme.palette.primary.contrastText, opacity: 0.85 }}
                    >
                      {viewModal.pair.service_1}
                    </Typography>
                  </Box>

                  {/* Metadata */}
                  <Box
                    style={{
                      padding: '12px',
                      backgroundColor: theme.palette.background.paper,
                      borderTop: `1px solid ${theme.palette.divider}`,
                    }}
                  >
                    <Typography variant="caption" color="textSecondary" display="block" gutterBottom>
                      Source Code
                    </Typography>
                    <Box
                      component="pre"
                      style={{
                        margin: 0,
                        padding: 12,
                        overflowX: 'auto',
                        whiteSpace: 'pre-wrap',
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: 'monospace',
                        backgroundColor: theme.palette.action.hover,
                        borderRadius: 6,
                        color: theme.palette.text.primary,
                      }}
                    >
                      <code>{viewModal.pair.code_1 || 'No source code available'}</code>
                    </Box>
                  </Box>
                </Box>
              </Grid>

              {/* Function 2 */}
              <Grid item xs={12} md={6}>
                <Box
                  style={{
                    border: `2px solid ${theme.palette.secondary.main}`,
                    borderRadius: theme.shape.borderRadius,
                    overflow: 'hidden',
                  }}
                >
                  {/* Header */}
                  <Box
                    style={{
                      backgroundColor: theme.palette.secondary.main,
                      padding: '8px 12px',
                    }}
                  >
                    <Typography
                      variant="subtitle2"
                      style={{ color: theme.palette.secondary.contrastText, fontWeight: 'bold' }}
                    >
                      Function 2
                    </Typography>
                    <Typography
                      variant="caption"
                      style={{ color: theme.palette.secondary.contrastText, opacity: 0.85 }}
                    >
                      {viewModal.pair.service_2}
                    </Typography>
                  </Box>

                  {/* Metadata */}
                  <Box
                    style={{
                      padding: '12px',
                      backgroundColor: theme.palette.background.paper,
                      borderTop: `1px solid ${theme.palette.divider}`,
                    }}
                  >
                    <Typography variant="caption" color="textSecondary" display="block" gutterBottom>
                      Source Code
                    </Typography>
                    <Box
                      component="pre"
                      style={{
                        margin: 0,
                        padding: 12,
                        overflowX: 'auto',
                        whiteSpace: 'pre-wrap',
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: 'monospace',
                        backgroundColor: theme.palette.action.hover,
                        borderRadius: 6,
                        color: theme.palette.text.primary,
                      }}
                    >
                      <code>{viewModal.pair.code_2 || 'No source code available'}</code>
                    </Box>
                  </Box>
                </Box>
              </Grid>

              {/* Recommendation detail */}
              {viewModal.pair.recommendation && (
                <Grid item xs={12}>
                  <Paper
                    variant="outlined"
                    style={{
                      padding: 12,
                      borderLeft: `4px solid ${
                        viewModal.pair.recommendation.urgency === 'HIGH'   ? theme.palette.error.main :
                        viewModal.pair.recommendation.urgency === 'MEDIUM' ? theme.palette.warning.main :
                        theme.palette.success.main
                      }`,
                    }}
                  >
                    <Typography variant="subtitle2" gutterBottom>
                      💡 Refactoring Recommendation
                    </Typography>
                    <Box display="flex" style={{ gap: 8, marginBottom: 6 }}>
                      <Chip
                        label={`Urgency: ${viewModal.pair.recommendation.urgency}`}
                        size="small"
                        color={getUrgencyColor(viewModal.pair.recommendation.urgency)}
                      />
                      <Chip
                        label={viewModal.pair.recommendation.same_language ? 'Same Language' : 'Cross Language'}
                        size="small"
                        variant="outlined"
                      />
                    </Box>
                    <Typography variant="body2">
                      {viewModal.pair.recommendation.detail}
                    </Typography>
                  </Paper>
                </Grid>
              )}

            </Grid>
          )}
        </DialogContent>
      </Dialog>

    </Page>
  );
};