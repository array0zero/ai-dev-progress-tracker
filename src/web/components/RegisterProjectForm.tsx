import { type FormEvent, useEffect, useState } from 'react'
import { ApiError, createProject } from '../api/client.js'

export interface RegisterProjectPrefill {
  name: string
  localPath: string
}

export interface RegisterProjectFormProps {
  onRegistered: () => void | Promise<void>
  onError: (error: { code: string; message: string }) => void
  /** failed candidate からの手動登録導線。値を入れるだけで project は作らない。 */
  prefill?: RegisterProjectPrefill | null
}

export function RegisterProjectForm({ onRegistered, onError, prefill }: RegisterProjectFormProps) {
  const [name, setName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [repository, setRepository] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (prefill != null) {
      setName(prefill.name)
      setLocalPath(prefill.localPath)
    }
  }, [prefill])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    try {
      await createProject({ name, localPath, repository })
      setName('')
      setLocalPath('')
      setRepository('')
      await onRegistered()
    } catch (error) {
      if (error instanceof ApiError) {
        onError({ code: error.code, message: error.message })
      } else {
        onError({ code: 'INTERNAL_ERROR', message: 'Registration failed.' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="register-form" onSubmit={handleSubmit}>
      <label>
        プロジェクト名
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label>
        ローカルGit rootパス
        <input value={localPath} onChange={(event) => setLocalPath(event.target.value)} required />
      </label>
      <label>
        GitHub リポジトリ (owner/repo)
        <input
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          required
        />
      </label>
      <button type="submit" disabled={submitting}>
        登録
      </button>
    </form>
  )
}
