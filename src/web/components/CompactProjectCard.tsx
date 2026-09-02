import type { ProjectSummaryV2 } from '../../shared/api.js'

const NEEDS_INPUT_LABEL = '要補完'

export interface CompactProjectCardProps {
  project: ProjectSummaryV2
}

/** compact view。dense と同じ ProjectSummaryV2 だけを使い、管理 data は変えない。 */
export function CompactProjectCard({ project }: CompactProjectCardProps) {
  return (
    <article className="compact-card" aria-label={project.name}>
      <a className="compact-card__name" href={`/projects/${project.id}`}>
        {project.name}
      </a>
      <p className="compact-card__summary">{project.summary}</p>
      <p className="compact-card__current">{project.currentPosition ?? NEEDS_INPUT_LABEL}</p>
      <p className="compact-card__next">
        {project.nextActions.length > 0 ? project.nextActions.join(' / ') : '—'}
      </p>
      <p className="compact-card__updated">{new Date(project.lastUpdatedAt).toLocaleString()}</p>
      <div className="compact-card__badges">
        {project.unreflected ? <span className="badge badge--unreflected">未反映</span> : null}
        {project.reviewRequired ? <span className="badge badge--review">要確認</span> : null}
        {project.hasNextAction ? <span className="badge badge--next">次の作業あり</span> : null}
      </div>
    </article>
  )
}
