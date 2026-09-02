import { z } from 'zod'

export const registerProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  localPath: z.string().trim().min(1),
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'repository must be in "owner/repo" form'),
})

export type RegisterProjectRequest = z.infer<typeof registerProjectRequestSchema>

export const reviewRequestSchema = z.object({
  required: z.boolean(),
})

export type ReviewRequest = z.infer<typeof reviewRequestSchema>
