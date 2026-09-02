import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary, SystemStatus } from '../../shared/api.js'
import type { RegistrationCandidate } from '../../shared/domain.js'
import { ApiError, fetchCandidates, fetchProjects, reopenCandidate } from '../api/client.js'
import { ProjectCard } from '../components/ProjectCard.js'
import {
  RegisterProjectForm,
  type RegisterProjectPrefill,
} from '../components/RegisterProjectForm.js'
import { RegistrationCandidatePanel } from '../components/RegistrationCandidatePanel.js'
import { RegistrationPrompt } from '../components/RegistrationPrompt.js'
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

function candidateIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('candidate')
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [candidates, setCandidates] = useState<RegistrationCandidate[]>([])
  const [prefill, setPrefill] = useState<RegisterProjectPrefill | null>(null)
  const promptCandidateId = candidateIdFromUrl()
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
    try {
      setCandidates(await fetchCandidates())
    } catch {
      setCandidates([])
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

      {promptCandidateId !== null ? (
        <RegistrationPrompt candidateId={promptCandidateId} onSettled={reload} />
      ) : null}

      <RegistrationCandidatePanel
        candidates={candidates}
        onReopen={async (candidate) => {
          await reopenCandidate(candidate.id)
          await reload()
        }}
        onManualRegister={(candidate) =>
          setPrefill({ name: candidate.suggestedName, localPath: candidate.localPath })
        }
      />

      <RegisterProjectForm onRegistered={reload} onError={setBanner} prefill={prefill} />

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
