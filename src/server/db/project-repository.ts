import type { ProjectStatus } from '../../shared/domain.js'
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
  createdAt: string
  updatedAt: string
}

export type NewProject = Omit<ProjectRecord, 'createdAt' | 'updatedAt'>

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
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS =
  'id, name, local_path, repo_node_id, repo_owner, repo_name, repo_url, default_branch, status, created_at, updated_at'

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertProject(db: Db, project: NewProject, now: Date = new Date()): ProjectRecord {
  const ts = now.toISOString()
  db.prepare(
    `INSERT INTO projects
       (id, name, local_path, repo_node_id, repo_owner, repo_name, repo_url, default_branch, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ts,
    ts,
  )
  return { ...project, createdAt: ts, updatedAt: ts }
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
