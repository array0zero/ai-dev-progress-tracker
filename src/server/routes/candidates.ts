import type { FastifyPluginAsync } from 'fastify'
import type { ApiErrorBody } from '../../shared/api.js'
import {
  beginRegistration,
  declineCandidate,
  getCandidate,
  listCandidates,
  reopenCandidate,
} from '../db/candidate-repository.js'
import type { Db } from '../db/connection.js'
import { approveCandidateRequestSchema, candidateStatusQuerySchema } from '../schemas/candidate.js'
import { startRegistrationWorker } from '../services/registration-service.js'

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

const ALREADY_DECIDED = errorBody(
  'CANDIDATE_ALREADY_DECIDED',
  'This candidate is not in a state that accepts the request.',
)

export function candidateRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.get('/candidates', async (request, reply) => {
      const parsed = candidateStatusQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.code(400).send(errorBody('INVALID_REQUEST', 'status filter is invalid.'))
      }
      return { candidates: listCandidates(db, parsed.data.status) }
    })

    app.get('/candidates/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const candidate = getCandidate(db, id)
      if (candidate === null) {
        return reply.code(404).send(errorBody('CANDIDATE_NOT_FOUND', 'Candidate not found.'))
      }
      return candidate
    })

    // 承認は state を registering へ進めるだけで、登録本体は worker が実行する。
    app.post('/candidates/:id/approve', async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = approveCandidateRequestSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(errorBody('INVALID_REQUEST', 'Request body is invalid.'))
      }
      if (getCandidate(db, id) === null) {
        return reply.code(404).send(errorBody('CANDIDATE_NOT_FOUND', 'Candidate not found.'))
      }
      const name =
        parsed.data.name === undefined || parsed.data.name === '' ? null : parsed.data.name
      if (!beginRegistration(db, id, new Date(), name)) {
        return reply.code(409).send(ALREADY_DECIDED)
      }
      startRegistrationWorker(db, id)
      return reply.code(202).send({ candidateId: id, status: 'registering' })
    })

    app.post('/candidates/:id/decline', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (getCandidate(db, id) === null) {
        return reply.code(404).send(errorBody('CANDIDATE_NOT_FOUND', 'Candidate not found.'))
      }
      if (!declineCandidate(db, id)) {
        return reply.code(409).send(ALREADY_DECIDED)
      }
      return { candidateId: id, status: 'declined' }
    })

    app.post('/candidates/:id/reopen', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (getCandidate(db, id) === null) {
        return reply.code(404).send(errorBody('CANDIDATE_NOT_FOUND', 'Candidate not found.'))
      }
      if (!reopenCandidate(db, id)) {
        return reply.code(409).send(ALREADY_DECIDED)
      }
      return { candidateId: id, status: 'detected' }
    })
  }
}
