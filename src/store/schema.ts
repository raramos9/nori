import type { Kysely } from 'kysely';

export interface ApplicationsTable {
  id: string;
  repo_identity: string;
  subpath: string;
  framework: string;
}

export interface SnapshotsTable {
  id: string;
  application_id: string;
  commit_sha: string;
  source_hash: string;
  worktree: string;
  branch: string | null;
  created_at: string;
}

export interface AnalysesTable {
  id: string;
  snapshot_id: string;
  analyzer_version: string;
  inputs_hash: string;
  created_at: string;
}

export interface ScreensTable {
  id: string;
  application_id: string;
  route_pattern: string;
}

export interface UiStatesTable {
  id: string;
  screen_id: string;
  key: string;
}

export interface TransitionsTable {
  id: string;
  source_state_id: string;
  trigger_kind: string;
  target_kind: string;
  target_state_id: string | null;
  unresolved_reason: string | null;
  unresolved_expression: string | null;
}

export interface StaticEvidenceTable {
  id: string;
  analysis_id: string;
  extractor: string;
  span_file: string;
  span_start_line: number;
  span_start_column: number;
  span_end_line: number;
  span_end_column: number;
}

export interface StaticObservationsTable {
  analysis_id: string;
  evidence_id: string;
  subject_kind: string;
  subject_id: string;
  verdict: string;
}

export interface RunsTable {
  id: string;
  snapshot_id: string;
  origin: string;
  session_kind: string;
  session_label: string;
  environment: string;
  seeded_by: string;
  started_at: string;
  finished_at: string;
  stop: string;
  crawler_version: string;
  requests_allowed: number;
  requests_blocked: number;
}

export interface CapturesTable {
  evidence_id: string;
  run_id: string;
  url: string;
  http_status: number;
  screenshot_path: string;
  dom_path: string;
}

export interface NavigationsTable {
  evidence_id: string;
  run_id: string;
  start_kind: string;
  from_capture_id: string | null;
  action_kind: string | null;
  action: string | null;
  requested_url: string;
  redirects: string;
  landing_capture_id: string;
  log_seq: number;
}

export interface MatchesTable {
  snapshot_id: string;
  run_id: string;
  analysis_id: string;
  created_at: string;
}

export interface ScreenMatchesTable {
  snapshot_id: string;
  run_id: string;
  analysis_id: string;
  capture_id: string;
  screen_id: string;
  verdict: string;
  match: string;
}

export interface TransitionMatchesTable {
  snapshot_id: string;
  run_id: string;
  analysis_id: string;
  navigation_id: string;
  transition_id: string;
  verdict: string;
  match: string;
}

export interface MatchFailuresTable {
  snapshot_id: string;
  sealed_run_id: string;
  analysis_id: string;
  error: string;
  created_at: string;
}

export interface Database {
  applications: ApplicationsTable;
  snapshots: SnapshotsTable;
  analyses: AnalysesTable;
  screens: ScreensTable;
  ui_states: UiStatesTable;
  transitions: TransitionsTable;
  static_evidence: StaticEvidenceTable;
  static_observations: StaticObservationsTable;
  runs: RunsTable;
  captures: CapturesTable;
  navigations: NavigationsTable;
  matches: MatchesTable;
  screen_matches: ScreenMatchesTable;
  transition_matches: TransitionMatchesTable;
  match_failures: MatchFailuresTable;
}

export type GraphDb = Kysely<Database>;
