export type StatusBannerVariant = 'error' | 'warning'

export interface StatusBannerProps {
  code: string
  message: string
  variant?: StatusBannerVariant
}

export function StatusBanner({ code, message, variant = 'error' }: StatusBannerProps) {
  return (
    <div className={`status-banner status-banner--${variant}`} role="alert">
      <span className="status-banner__code">{code}</span>
      <span className="status-banner__message">{message}</span>
    </div>
  )
}
