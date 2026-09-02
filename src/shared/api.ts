import type { ProgressRecoveryStatus } from './domain.js'

export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

/** DESIGN.md「エラーレスポンス共通形式」の固定 code 一覧。 */
export const API_ERROR_CODES = [
  'INVALID_REQUEST',
  'PROJECT_NOT_FOUND',
  'PROJECT_ALREADY_REGISTERED',
  'CANDIDATE_NOT_FOUND',
  'CANDIDATE_ALREADY_DECIDED',
  'RUN_ALREADY_ACTIVE',
  'BACKUP_ALREADY_ACTIVE',
  'NOT_GIT_ROOT',
  'GIT_LAYOUT_UNSUPPORTED',
  'CUSTOM_HOOKS_PATH_UNSUPPORTED',
  'REPOSITORY_MISMATCH',
  'GITHUB_AUTH_REQUIRED',
  'HOOK_UNSUPPORTED',
  'SNAPSHOT_INCONSISTENT',
  'FORBIDDEN_HOST',
  'FORBIDDEN_ORIGIN',
  'NODE_VERSION_UNSUPPORTED',
  'GIT_VERSION_UNSUPPORTED',
  'GH_VERSION_UNSUPPORTED',
  'CODEX_VERSION_UNSUPPORTED',
  'VERSION_PARSE_ERROR',
  'CODEX_AUTH_REQUIRED',
  'AI_AUTH_NOT_CHATGPT',
  'INTERNAL_ERROR',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export interface HealthResponse {
  status: 'ok'
  db: 'ok' | 'error'
}

export interface EvidenceRef {
  id: string
  kind: 'commit' | 'issue' | 'pull_request'
  externalKey: string
  title: string
  url: string | null
}

export interface DecisionView {
  decision: string
  rationale: string
  evidence: EvidenceRef[]
}

export interface ProjectSummary {
  id: string
  name: string
  repository: string
  repositoryUrl: string
  lastCommitSha: string | null
  progressStatus: ProgressRecoveryStatus | null
  currentPosition: string | null
  completedItems: string[]
  nextActions: string[]
  generationStatus: string | null
  backupStatus: string | null
}

export interface ProjectDetail extends ProjectSummary {
  importantDecisions: DecisionView[]
  allEvidence: EvidenceRef[]
  missingFields: string[]
}

export interface RegisterProjectRequestBody {
  name: string
  localPath: string
  repository: string
}

export interface GenerationFailureSummary {
  projectId: string
  projectName: string
  runId: string
  status: string
  errorCode: string | null
  detectedAt: string
}

export interface BackupFailureSummary {
  backupRunId: string
  errorCode: string | null
  queuedAt: string
}

export interface SystemStatus {
  latestGenerationFailure: GenerationFailureSummary | null
  latestBackupFailure: BackupFailureSummary | null
}
