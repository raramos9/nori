import type { Kysely } from 'kysely';

// Rows are plain strings and nullable columns; branded/union types are built in graph-store.ts.
export interface ApplicationsTable {
  id: string;
  root_path: string;
  framework: string;
}

export interface BuildsTable {
  id: string;
  application_id: string;
  commit_sha: string;
  source_hash: string;
  branch: string | null;
  analyzer_version: string;
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

export interface EvidenceTable {
  id: string;
  build_id: string;
  kind: string;
  extractor: string | null;
  span_file: string | null;
  span_start_line: number | null;
  span_start_column: number | null;
  span_end_line: number | null;
  span_end_column: number | null;
}

export interface ObservationsTable {
  evidence_id: string;
  subject_kind: string;
  subject_id: string;
  verdict: string;
}

export interface Database {
  applications: ApplicationsTable;
  builds: BuildsTable;
  screens: ScreensTable;
  ui_states: UiStatesTable;
  transitions: TransitionsTable;
  evidence: EvidenceTable;
  observations: ObservationsTable;
}

export type GraphDb = Kysely<Database>;
