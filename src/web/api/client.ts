import type {
  ApiErrorBody,
  ProjectDetail,
  ProjectSummary,
  RegisterProjectRequestBody,
} from '../../shared/api.js'

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
