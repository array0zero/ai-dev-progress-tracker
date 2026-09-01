import { useCallback, useEffect, useState } from 'react'
import type { DecisionView, ProjectDetail } from '../../shared/api.js'
import { ApiError, fetchProject } from '../api/client.js'
import { EvidenceList } from '../components/EvidenceList.js'
import { ProgressSection } from '../components/ProgressSection.js'
import { StatusBanner } from '../components/StatusBanner.js'

interface BannerState {
  code: string
  message: string
}

export interface ProjectDetailPageProps {
  projectId: string
}

export function ProjectDetailPage({ projectId }: ProjectDetailPageProps) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setDetail(await fetchProject(projectId))
      setBanner(null)
    } catch (error) {
      setDetail(null)
      if (error instanceof ApiError) {
        setBanner({ code: error.code, message: error.message })
      } else {
        setBanner({ code: 'INTERNAL_ERROR', message: 'Failed to load the project.' })
      }
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="app">
      <a className="detail-back" href="/">
        ← 一覧へ
      </a>

      {banner !== null ? <StatusBanner code={banner.code} message={banner.message} /> : null}
      {loading ? <p>読み込み中…</p> : null}

      {detail !== null ? (
        <article className="project-detail" aria-label={detail.name}>
          <h1>{detail.name}</h1>
          <p className="project-detail__repo">{detail.repository}</p>
          <p className="project-detail__sha">{detail.lastCommitSha?.slice(0, 8) ?? '—'}</p>

          <ProgressSection
            title="現在地"
            text={detail.currentPosition}
            missing={detail.missingFields.includes('currentPosition')}
          />
          <ProgressSection
            title="完了事項"
            items={detail.completedItems}
            missing={detail.missingFields.includes('completedItems')}
          />
          <ProgressSection
            title="次の作業"
            items={detail.nextActions}
            missing={detail.missingFields.includes('nextActions')}
          />

          <DecisionsBlock
            decisions={detail.importantDecisions}
            missing={detail.missingFields.includes('importantDecisions')}
          />
        </article>
      ) : null}
    </main>
  )
}

function DecisionsBlock({ decisions, missing }: { decisions: DecisionView[]; missing: boolean }) {
  return (
    <section className="project-detail__decisions">
      <h2>重要な判断事項</h2>
      {renderDecisions(decisions, missing)}
    </section>
  )
}

function renderDecisions(decisions: DecisionView[], missing: boolean) {
  if (missing) {
    return <p>要補完</p>
  }
  if (decisions.length === 0) {
    return <p>重要な判断事項: なし</p>
  }
  return decisions.map((decision) => (
    <div className="decision" key={decision.decision}>
      <h3 className="decision__decision">{decision.decision}</h3>
      <p className="decision__rationale">{decision.rationale}</p>
      <EvidenceList evidence={decision.evidence} />
    </div>
  ))
}
