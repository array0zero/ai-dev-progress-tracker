export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

export interface HealthResponse {
  status: 'ok'
  db: 'ok' | 'error'
}
