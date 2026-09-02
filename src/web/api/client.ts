import type {
  ApiErrorBody,
  ProgressHistoryPage,
  ProjectDetail,
  ProjectSummary,
  RegisterProjectRequestBody,
} from '../../shared/api.js'
import type { RegistrationCandidate } from '../../shared/domain.js'

export class ApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR'
  let message = `Request failed with status ${response.status}`
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>
    if (body.error && typeof body.error.code === 'string') {
      code = body.error.code
      message = body.error.message
    }
  } catch {
    // keep defaults
  }
  return new ApiError(code, message)
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects')
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as ProjectSummary[]
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`)
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as ProjectDetail
}

export async function recoverProject(id: string): Promise<{ runId: string; status: string }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as { runId: string; status: string }
}

export async function createProject(body: RegisterProjectRequestBody): Promise<ProjectDetail> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as ProjectDetail
}

export async function fetchCandidates(): Promise<RegistrationCandidate[]> {
  const response = await fetch('/api/candidates')
  if (!response.ok) {
    throw await toApiError(response)
  }
  return ((await response.json()) as { candidates: RegistrationCandidate[] }).candidates
}

export async function fetchCandidate(id: string): Promise<RegistrationCandidate> {
  const response = await fetch(`/api/candidates/${encodeURIComponent(id)}`)
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as RegistrationCandidate
}

async function postCandidate(id: string, action: string, body: unknown): Promise<void> {
  const response = await fetch(`/api/candidates/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) {
    throw await toApiError(response)
  }
}

export function approveCandidate(id: string, name?: string): Promise<void> {
  return postCandidate(id, 'approve', name === undefined ? {} : { name })
}

export function declineCandidate(id: string): Promise<void> {
  return postCandidate(id, 'decline', {})
}

export function reopenCandidate(id: string): Promise<void> {
  return postCandidate(id, 'reopen', {})
}

export interface ReviewState {
  projectId: string
  reviewRequired: boolean
  reviewRequiredAt: string | null
}

export async function setProjectReview(id: string, required: boolean): Promise<ReviewState> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ required }),
  })
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as ReviewState
}

export async function fetchProgressHistory(
  id: string,
  before?: string,
): Promise<ProgressHistoryPage> {
  const params = new URLSearchParams({ limit: '20' })
  if (before !== undefined) {
    params.set('before', before)
  }
  const response = await fetch(
    `/api/projects/${encodeURIComponent(id)}/history?${params.toString()}`,
  )
  if (!response.ok) {
    throw await toApiError(response)
  }
  return (await response.json()) as ProgressHistoryPage
}
