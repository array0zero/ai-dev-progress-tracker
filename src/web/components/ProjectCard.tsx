import type { ProjectSummary } from '../../shared/api.js'

const NEEDS_INPUT_LABEL = '要補完'
const NO_SNAPSHOT_LABEL = '進捗生成中'

export interface ProjectCardProps {
  project: ProjectSummary
}

function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 8)
}

function textField(value: string | null, hasSnapshot: boolean): string {
  if (!hasSnapshot) {
    return NO_SNAPSHOT_LABEL
  }
  return value === null || value === '' ? NEEDS_INPUT_LABEL : value
}

function ListField({ items, hasSnapshot }: { items: string[]; hasSnapshot: boolean }) {
  if (!hasSnapshot) {
    return <span>{NO_SNAPSHOT_LABEL}</span>
  }
  if (items.length === 0) {
    return <span>{NEEDS_INPUT_LABEL}</span>
  }
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

export function ProjectCard({ project }: ProjectCardProps) {
  const hasSnapshot = project.progressStatus !== null
  return (
    <article className="project-card" aria-label={project.name}>
      <h2 className="project-card__name">{project.name}</h2>
      <p className="project-card__repo">{project.repository}</p>
      <p className="project-card__sha">{shortSha(project.lastCommitSha)}</p>

      <dl className="project-card__progress">
        <dt>現在地</dt>
        <dd>{textField(project.currentPosition, hasSnapshot)}</dd>
        <dt>完了事項</dt>
        <dd>
          <ListField items={project.completedItems} hasSnapshot={hasSnapshot} />
        </dd>
        <dt>次の作業</dt>
        <dd>
          <ListField items={project.nextActions} hasSnapshot={hasSnapshot} />
        </dd>
      </dl>

      <p className="project-card__generation">generation: {project.generationStatus ?? '—'}</p>
      <p className="project-card__backup">backup: {project.backupStatus ?? '—'}</p>
      <a className="project-card__link" href={`/projects/${project.id}`}>
        詳細
      </a>
    </article>
  )
}
