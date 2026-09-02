import { useCallback, useEffect, useState } from 'react'
import type { ProgressHistoryItem } from '../../shared/api.js'
import { ApiError, fetchProgressHistory } from '../api/client.js'

export interface ProgressHistoryProps {
  projectId: string
}

/** 現在の状態とは別 section の進捗履歴。newest-first、20 件ずつ load more (DESIGN D018)。 */
export function ProgressHistory({ projectId }: ProgressHistoryProps) {
  const [items, setItems] = useState<ProgressHistoryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadPage = useCallback(
    async (before?: string) => {
      setLoading(true)
      try {
        const page = await fetchProgressHistory(projectId, before)
        setItems((current) => (before === undefined ? page.items : [...current, ...page.items]))
        setCursor(page.nextCursor)
        setError(null)
      } catch (loadError) {
        setError(loadError instanceof ApiError ? loadError.code : 'INTERNAL_ERROR')
      } finally {
        setLoading(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  return (
    <section className="progress-history" aria-label="進捗履歴">
      <hr className="progress-history__divider" />
      <h2>進捗履歴</h2>
      {error !== null ? <p role="alert">{error}</p> : null}
      {!loading && items.length === 0 ? <p>履歴なし</p> : null}
      <ol className="progress-history__list">
        {items.map((item) => (
          <li key={item.snapshotId} className="progress-history__item">
            <span className="progress-history__time">
              {new Date(item.createdAt).toLocaleString()}
            </span>
            <span className="progress-history__sha">{item.commitSha.slice(0, 8)}</span>
            <span className="progress-history__status">{item.recoveryStatus}</span>
            <span className="progress-history__current">{item.currentPosition ?? '要補完'}</span>
          </li>
        ))}
      </ol>
      {cursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void loadPage(cursor)}>
          さらに読み込む
        </button>
      ) : null}
    </section>
  )
}
