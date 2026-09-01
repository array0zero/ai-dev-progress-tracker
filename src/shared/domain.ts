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
