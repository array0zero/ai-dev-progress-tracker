import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary } from '../../shared/api.js'
import { ApiError, fetchProjects } from '../api/client.js'
import { ProjectCard } from '../components/ProjectCard.js'
import { RegisterProjectForm } from '../components/RegisterProjectForm.js'
import { StatusBanner } from '../components/StatusBanner.js'

interface BannerState {
  code: string
  message: string
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [banner, setBanner] = useState<BannerState | null>(null)
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
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <main className="app">
      <header className="app-header">
        <h1>AI Dev Progress Tracker</h1>
      </header>

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
