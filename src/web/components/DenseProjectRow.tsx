import type { ProjectSummaryV2 } from '../../shared/api.js'

const NEEDS_INPUT_LABEL = '要補完'

export interface DenseProjectRowProps {
  project: ProjectSummaryV2
}

function localTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function nextActionText(project: ProjectSummaryV2): string {
  if (project.nextActions.length > 0) {
    return project.nextActions.join(' / ')
  }
  return project.progressStatus === null ? '—' : NEEDS_INPUT_LABEL
}

/** DESIGN「Dense list固定レイアウト」: 104px 行、4 columns、name と現在地を最も強くする。 */
export function DenseProjectRow({ project }: DenseProjectRowProps) {
  return (
    <article className="dense-row" aria-label={project.name}>
      <div className="dense-row__main">
        <a className="dense-row__name" href={`/projects/${project.id}`}>
          {project.name}
        </a>
        <p className="dense-row__current">{project.currentPosition ?? NEEDS_INPUT_LABEL}</p>
        <p className="dense-row__repo">{project.repository}</p>
      </div>
      <p className="dense-row__next">{nextActionText(project)}</p>
      <p className="dense-row__updated">{localTime(project.lastUpdatedAt)}</p>
      <div className="dense-row__badges">
        {project.unreflected ? <span className="badge badge--unreflected">未反映</span> : null}
        {project.reviewRequired ? <span className="badge badge--review">要確認</span> : null}
        {project.hasNextAction ? <span className="badge badge--next">次の作業あり</span> : null}
      </div>
    </article>
  )
}
