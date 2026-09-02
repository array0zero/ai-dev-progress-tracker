import { useCallback, useEffect, useState } from 'react'
import type { RegistrationCandidate } from '../../shared/domain.js'
import { ApiError, approveCandidate, declineCandidate, fetchCandidate } from '../api/client.js'

const POLL_INTERVAL_MS = 500

export interface RegistrationPromptProps {
  candidateId: string
  onSettled: () => void | Promise<void>
}

/** `/?candidate=<id>` で最優先表示する登録確認。registering の間だけ poll する。 */
export function RegistrationPrompt({ candidateId, onSettled }: RegistrationPromptProps) {
  const [candidate, setCandidate] = useState<RegistrationCandidate | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<RegistrationCandidate | null> => {
    try {
      const next = await fetchCandidate(candidateId)
      setCandidate(next)
      setName((current) => (current === '' ? next.suggestedName : current))
      setError(null)
      return next
    } catch (loadError) {
      setError(loadError instanceof ApiError ? loadError.code : 'INTERNAL_ERROR')
      return null
    }
  }, [candidateId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (candidate?.status !== 'registering') {
      return
    }
    const timer = setInterval(() => {
      void load().then((next) => {
        if (next !== null && next.status !== 'registering') {
          void onSettled()
        }
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [candidate?.status, load, onSettled])

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
      await load()
      await onSettled()
    } catch (actionError) {
      setError(actionError instanceof ApiError ? actionError.code : 'INTERNAL_ERROR')
    } finally {
      setBusy(false)
    }
  }

  if (candidate === null) {
    return (
      <section className="registration-prompt" aria-label="登録確認">
        {error === null ? <p>読み込み中…</p> : <p role="alert">{error}</p>}
      </section>
    )
  }

  return (
    <section className="registration-prompt" aria-label="登録確認">
      <h2>このプロジェクトを登録しますか？</h2>
      <p className="registration-prompt__path">{candidate.localPath}</p>
      {error !== null ? <p role="alert">{error}</p> : null}

      {candidate.status === 'detected' || candidate.status === 'prompted' ? (
        <>
          <label>
            プロジェクト名
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="registration-prompt__actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => approveCandidate(candidateId, name.trim()))}
            >
              登録する
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => declineCandidate(candidateId))}
            >
              登録しない
            </button>
          </div>
        </>
      ) : null}

      {candidate.status === 'registering' ? <p>登録中…</p> : null}
      {candidate.status === 'registered' ? <p>登録しました。</p> : null}
      {candidate.status === 'declined' ? <p>このフォルダは登録しませんでした。</p> : null}
      {candidate.status === 'failed' ? (
        <p role="alert">登録に失敗しました: {candidate.lastErrorCode ?? 'INTERNAL_ERROR'}</p>
      ) : null}
    </section>
  )
}
