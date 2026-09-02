import { z } from 'zod'

/** approve 時の name override。空文字 / 未指定は suggested name を使う。 */
export const approveCandidateRequestSchema = z.object({
  name: z.string().trim().max(120).optional(),
})

export const candidateStatusQuerySchema = z.object({
  status: z
    .enum(['detected', 'prompted', 'declined', 'registering', 'failed', 'registered'])
    .optional(),
})

export type ApproveCandidateRequest = z.infer<typeof approveCandidateRequestSchema>
