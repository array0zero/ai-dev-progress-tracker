import type { RegistrationCandidate } from '../../shared/domain.js'

const STATUS_LABEL: Record<string, string> = {
  detected: '未確認',
  prompted: '確認待ち',
  registering: '登録中',
  failed: '登録失敗',
  declined: '登録しない',
}

export interface RegistrationCandidatePanelProps {
  candidates: RegistrationCandidate[]
  onReopen: (candidate: RegistrationCandidate) => void | Promise<void>
  onManualRegister: (candidate: RegistrationCandidate) => void
}

/** 未登録候補。失敗した candidate も自動削除せず error code つきで残す。 */
export function RegistrationCandidatePanel({
  candidates,
  onReopen,
  onManualRegister,
}: RegistrationCandidatePanelProps) {
  const pending = candidates.filter((candidate) => candidate.status !== 'registered')
  if (pending.length === 0) {
    return null
  }

  return (
    <section className="candidate-panel" aria-label="未登録の候補">
      <h2>未登録の候補</h2>
      <ul>
        {pending.map((candidate) => (
          <li key={candidate.id} className="candidate-panel__row">
            <span className="candidate-panel__name">{candidate.suggestedName}</span>
            <span className="candidate-panel__path">{candidate.localPath}</span>
            <span className="candidate-panel__status">
              {STATUS_LABEL[candidate.status] ?? candidate.status}
            </span>
            {candidate.lastErrorCode !== null ? (
              <span className="candidate-panel__error">{candidate.lastErrorCode}</span>
            ) : null}
            {candidate.status === 'detected' || candidate.status === 'prompted' ? (
              <a href={`/?candidate=${candidate.id}`}>登録確認を開く</a>
            ) : null}
            {candidate.status === 'failed' || candidate.status === 'declined' ? (
              <button type="button" onClick={() => void onReopen(candidate)}>
                やり直す
              </button>
            ) : null}
            {candidate.status === 'failed' ? (
              <button type="button" onClick={() => onManualRegister(candidate)}>
                手動で登録
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
