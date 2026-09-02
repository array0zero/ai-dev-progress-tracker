import type { ProjectStatus, RegistrationSource } from '../../shared/domain.js'
import type { Db } from './connection.js'

export interface ProjectRecord {
  id: string
  name: string
  localPath: string
  repoNodeId: string
  repoOwner: string
  repoName: string
  repoUrl: string
  defaultBranch: string
  status: ProjectStatus
  summary: string
  registrationSource: RegistrationSource
  reviewRequired: boolean
  reviewRequiredAt: string | null
  createdAt: string
  updatedAt: string
}

/** v2 field は既定値を持つので、v1 由来の呼び出し側はそのまま insert できる。 */
export type NewProject = Omit<
  ProjectRecord,
  | 'createdAt'
  | 'updatedAt'
  | 'summary'
  | 'registrationSource'
  | 'reviewRequired'
  | 'reviewRequiredAt'
> &
  Partial<Pick<ProjectRecord, 'summary' | 'registrationSource' | 'reviewRequired'>>

interface ProjectRow {
  id: string
  name: string
  local_path: string
  repo_node_id: string
  repo_owner: string
  repo_name: string
  repo_url: string
  default_branch: string
  status: string
  summary: string
  registration_source: string
  review_required: number
  review_required_at: string | null
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS =
  'id, name, local_path, repo_node_id, repo_owner, repo_name, repo_url, default_branch, status, summary, registration_source, review_required, review_required_at, created_at, updated_at'

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    localPath: row.local_path,
    repoNodeId: row.repo_node_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    status: row.status as ProjectStatus,
    summary: row.summary,
    registrationSource: row.registration_source as RegistrationSource,
    reviewRequired: row.review_required === 1,
    reviewRequiredAt: row.review_required_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertProject(db: Db, project: NewProject, now: Date = new Date()): ProjectRecord {
  const ts = now.toISOString()
  const summary = project.summary ?? project.name
  const registrationSource = project.registrationSource ?? 'manual'
  const reviewRequired = project.reviewRequired ?? false
  db.prepare(
    `INSERT INTO projects
       (id, name, local_path, repo_node_id, repo_owner, repo_name, repo_url, default_branch, status,
        summary, registration_source, review_required, review_required_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.localPath,
    project.repoNodeId,
    project.repoOwner,
    project.repoName,
    project.repoUrl,
    project.defaultBranch,
    project.status,
    summary,
    registrationSource,
    reviewRequired ? 1 : 0,
    reviewRequired ? ts : null,
    ts,
    ts,
  )
  return {
    ...project,
    summary,
    registrationSource,
    reviewRequired,
    reviewRequiredAt: reviewRequired ? ts : null,
    createdAt: ts,
    updatedAt: ts,
  }
}

export function getProjectById(db: Db, id: string): ProjectRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`).get(id) as
    | ProjectRow
    | undefined
  return row === undefined ? null : rowToProject(row)
}

export function findProjectByLocalPath(db: Db, localPath: string): ProjectRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE local_path = ?`)
    .get(localPath) as ProjectRow | undefined
  return row === undefined ? null : rowToProject(row)
}

export function findProjectByRepoNodeId(db: Db, repoNodeId: string): ProjectRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE repo_node_id = ?`)
    .get(repoNodeId) as ProjectRow | undefined
  return row === undefined ? null : rowToProject(row)
}

export function listProjects(db: Db): ProjectRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects ORDER BY created_at ASC, id ASC`)
    .all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function updateProjectStatus(
  db: Db,
  id: string,
  status: ProjectStatus,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now.toISOString(), id)
  return result.changes === 1
}

/** 要確認フラグ。true で設定時刻を記録し、false で消す (DESIGN D012)。 */
export function setProjectReviewRequired(
  db: Db,
  id: string,
  required: boolean,
  now: Date = new Date(),
): ProjectRecord | null {
  const ts = now.toISOString()
  const changed = db
    .prepare(
      'UPDATE projects SET review_required = ?, review_required_at = ?, updated_at = ? WHERE id = ?',
    )
    .run(required ? 1 : 0, required ? ts : null, ts, id).changes
  return changed === 1 ? getProjectById(db, id) : null
}
