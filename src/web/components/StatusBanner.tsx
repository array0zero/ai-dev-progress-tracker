export type StatusBannerVariant = 'error' | 'warning'

export interface StatusBannerProps {
  code: string
  message: string
  variant?: StatusBannerVariant
  /** 表示上の見出し (例: 「生成失敗」)。 */
  label?: string
}

export function StatusBanner({ code, message, variant = 'error', label }: StatusBannerProps) {
  return (
    <div
      className={`status-banner status-banner--${variant}`}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      {label !== undefined ? <span className="status-banner__label">{label}</span> : null}
      <span className="status-banner__code">{code}</span>
      <span className="status-banner__message">{message}</span>
    </div>
  )
}
