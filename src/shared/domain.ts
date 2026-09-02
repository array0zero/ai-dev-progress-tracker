export type ProjectStatus = 'active' | 'local_missing'

export type ProgressRecoveryStatus = 'complete' | 'partial' | 'unrecoverable'

export type GenerationRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'unrecoverable'
  | 'failed'

export type BackupRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** v2: project の登録入口。 */
export type RegistrationSource = 'manual' | 'codex' | 'claude'

/** v2: 未登録 folder の検知〜登録判断の state。 */
export type RegistrationCandidateStatus =
  | 'detected'
  | 'prompted'
  | 'declined'
  | 'registering'
  | 'failed'
  | 'registered'

/** v2: Codex/Claude が触った未登録 folder。local_path が一意。 */
export interface RegistrationCandidate {
  id: string
  localPath: string
  agent: 'codex' | 'claude'
  status: RegistrationCandidateStatus
  suggestedName: string
  detectedAt: string
  lastSeenAt: string
  promptedAt: string | null
  decisionAt: string | null
  attemptCount: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  projectId: string | null
}
