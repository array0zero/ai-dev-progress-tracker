export interface ReviewControlsProps {
  reviewRequired: boolean
  onToggleReview: (required: boolean) => void | Promise<void>
  onRegenerate: () => void | Promise<void>
  busy?: boolean
}

/**
 * 要確認フラグと再生成。regenerate が成功しても要確認は自動解除しない (DESIGN D012)。
 */
export function ReviewControls({
  reviewRequired,
  onToggleReview,
  onRegenerate,
  busy = false,
}: ReviewControlsProps) {
  return (
    <section className="review-controls" aria-label="要確認と再生成">
      <label className="review-controls__flag">
        <input
          type="checkbox"
          checked={reviewRequired}
          disabled={busy}
          onChange={(event) => void onToggleReview(event.target.checked)}
        />
        要確認
      </label>
      <button type="button" disabled={busy} onClick={() => void onRegenerate()}>
        進捗を再生成
      </button>
    </section>
  )
}
