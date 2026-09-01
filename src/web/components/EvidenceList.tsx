import type { EvidenceRef } from '../../shared/api.js'

const KIND_LABEL: Record<EvidenceRef['kind'], string> = {
  commit: 'commit',
  issue: 'Issue',
  pull_request: 'Pull Request',
}

export interface EvidenceListProps {
  evidence: EvidenceRef[]
}

export function EvidenceList({ evidence }: EvidenceListProps) {
  if (evidence.length === 0) {
    return <p className="evidence-list__empty">根拠なし</p>
  }
  return (
    <ul className="evidence-list">
      {evidence.map((ref) => (
        <li key={ref.id} className="evidence-list__item">
          <span className="evidence-list__kind">{KIND_LABEL[ref.kind]}</span>
          <span className="evidence-list__key">{ref.externalKey}</span>
          <span className="evidence-list__title">{ref.title}</span>
          {ref.url !== null ? (
            <a href={ref.url} target="_blank" rel="noreferrer">
              GitHub で開く
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
