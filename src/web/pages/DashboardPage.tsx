import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummaryV2, SystemStatus } from '../../shared/api.js'
import type { RegistrationCandidate } from '../../shared/domain.js'
import { ApiError, fetchCandidates, fetchProjects, reopenCandidate } from '../api/client.js'
import { type DashboardStateFilter, DashboardToolbar } from '../components/DashboardToolbar.js'
import { DenseProjectRow } from '../components/DenseProjectRow.js'
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

function matchesFilters(
  project: ProjectSummaryV2,
  filters: readonly DashboardStateFilter[],
): boolean {
  if (filters.length === 0) {
    return true
  }
  // 状態 filter は OR (DESIGN D015)。
  return filters.some((filter) =>
    filter === 'has_next_action'
      ? project.hasNextAction
      : filter === 'needs_review'
        ? project.reviewRequired
        : project.unreflected,
  )
}

/** DESIGN: default sort は lastUpdatedAt DESC、同値は name ASC。 */
function sortProjects(projects: readonly ProjectSummaryV2[]): ProjectSummaryV2[] {
  return [...projects].sort((a, b) => {
    if (a.lastUpdatedAt !== b.lastUpdatedAt) {
      return a.lastUpdatedAt < b.lastUpdatedAt ? 1 : -1
    }
    return a.name.localeCompare(b.name)
  })
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummaryV2[]>([])
  const [candidates, setCandidates] = useState<RegistrationCandidate[]>([])
  const [prefill, setPrefill] = useState<RegisterProjectPrefill | null>(null)
  const [filters, setFilters] = useState<DashboardStateFilter[]>([])
  const [query, setQuery] = useState('')
  const promptCandidateId = candidateIdFromUrl()
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setProjects((await fetchProjects()) as ProjectSummaryV2[])
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

  const visible = sortProjects(projects.filter((project) => matchesFilters(project, filters)))

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

      <DashboardToolbar
        filters={filters}
        onToggleFilter={(filter) =>
          setFilters((current) =>
            current.includes(filter)
              ? current.filter((value) => value !== filter)
              : [...current, filter],
          )
        }
        query={query}
        onQueryChange={setQuery}
        visibleCount={visible.length}
        totalCount={projects.length}
      />

      <section className="project-list project-list--dense">
        {loading ? <p>読み込み中…</p> : null}
        {!loading && projects.length === 0 ? (
          <p className="project-list__empty">登録済みプロジェクトはありません。</p>
        ) : null}
        {!loading && projects.length > 0 && visible.length === 0 ? (
          <p className="project-list__empty">条件に一致するプロジェクトはありません。</p>
        ) : null}
        {visible.map((project) => (
          <DenseProjectRow key={project.id} project={project} />
        ))}
      </section>

      <details className="manual-register">
        <summary>手動で登録</summary>
        <RegisterProjectForm onRegistered={reload} onError={setBanner} prefill={prefill} />
      </details>
    </main>
  )
}
