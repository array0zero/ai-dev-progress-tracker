export interface StatusBannerProps {
  code: string
  message: string
}

export function StatusBanner({ code, message }: StatusBannerProps) {
  return (
    <div className="status-banner" role="alert">
      <span className="status-banner__code">{code}</span>
      <span className="status-banner__message">{message}</span>
    </div>
  )
}
