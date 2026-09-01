import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary, SystemStatus } from '../../shared/api.js'
import { ApiError, fetchProjects } from '../api/client.js'
import { ProjectCard } from '../components/ProjectCard.js'
import { RegisterProjectForm } from '../components/RegisterProjectForm.js'
import { StatusBanner } from '../components/StatusBanner.js'

interface BannerState {
  code: string
  message: string
}

async function fetchSystemStatus(): Promise<SystemStatus | null> {
  try {
    const response = await fetch('/api/system/status')
    if (!response.ok) {
      return null
    }
    return (await response.json()) as SystemStatus
  } catch {
    return null
  }
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setProjects(await fetchProjects())
      setBanner(null)
    } catch (error) {
      if (error instanceof ApiError) {
        setBanner({ code: error.code, message: error.message })
      } else {
        setBanner({ code: 'INTERNAL_ERROR', message: 'Failed to load projects.' })
      }
    } finally {
      setLoading(false)
    }
    setSystem(await fetchSystemStatus())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <main className="app">
      <header className="app-header">
        <h1>AI Dev Progress Tracker</h1>
      </header>

      {system?.latestGenerationFailure != null ? (
        <StatusBanner
          variant="warning"
          label="最新の生成失敗"
          code={system.latestGenerationFailure.errorCode ?? system.latestGenerationFailure.status}
          message={`${system.latestGenerationFailure.projectName} (${system.latestGenerationFailure.runId})`}
        />
      ) : null}
      {system?.latestBackupFailure != null ? (
        <StatusBanner
          variant="warning"
          label="最新のバックアップ失敗"
          code={system.latestBackupFailure.errorCode ?? 'BACKUP_FAILED'}
          message={system.latestBackupFailure.backupRunId}
        />
      ) : null}

      {banner !== null ? <StatusBanner code={banner.code} message={banner.message} /> : null}

      <RegisterProjectForm onRegistered={reload} onError={setBanner} />

      <section className="project-list">
        {loading ? <p>読み込み中…</p> : null}
        {!loading && projects.length === 0 ? (
          <p className="project-list__empty">登録済みプロジェクトはありません。</p>
        ) : null}
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </section>
    </main>
  )
}
