import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'

// Set JWT env before loading shared auth so the singleton uses racesight
process.env.JWT_ISSUER = process.env.JWT_ISSUER || 'racesight-auth'
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'racesight-servers'

// Use CommonJS modules from shared via dynamic import wrappers
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authManager } = require('../../../../shared/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { csrfProtection } = require('../../../../shared/middleware/csrf')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authenticate } = require('../../../../shared/auth/middleware')

function createTestServer() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // set a permissive origin for test
    req.headers.origin = 'http://localhost:3000'
    next()
  })
  app.use(csrfProtection(['http://localhost:3000']))

  app.get('/api/health', (_req, res) => res.json({ ok: true }))

  app.post('/protected', authenticate, (_req, res) => {
    res.json({ success: true })
  })

  return app
}

describe('Shared auth integration', () => {
  let app: express.Express

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
    process.env.VITE_VERBOSE = 'true'
    app = createTestServer()
  })

  it('accepts a valid JWT in Authorization header', async () => {
    // Mock user active check so test does not require DB
    const originalIsUserActive = authManager.user.isUserActive.bind(authManager.user)
    authManager.user.isUserActive = async () => true

    const token = authManager.jwt.generateToken(
      {
        user_id: '3dbcc8d0-6666-4359-8f60-211277d27326',
        user_name: 'tester',
        first_name: 't',
        last_name: 'e',
        email: 't@example.com',
        is_verified: true,
        permissions: {}
      },
      'access'
    )

    // Test that invalid URL fails (this is expected behavior)
    // In some test environments, fetch might return a Response even for invalid URLs
    // So we check that it either returns null or fails
    const res = await fetch('http://localhost', {
      method: 'POST'
    }).catch(() => null)
    // Either null (failed) or a Response that indicates failure
    expect(res === null || (res && !res.ok)).toBe(true)

    // Use supertest dynamically to avoid dependency at runtime
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest')
    const response = await request(app)
      .post('/protected')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', 'csrf_token=dummytoken')
      .set('X-CSRF-Token', 'dummytoken')
      .send({})

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)

    authManager.user.isUserActive = originalIsUserActive
  })

  it('rejects a token with wrong audience', async () => {
    // Simulate separate services: sign with wrong audience then verify with correct audience
    const originalAudience = authManager.jwt.audience
    // @ts-expect-error allow mutation for test simulation
    authManager.jwt.audience = 'wrong-aud'

    const badToken = authManager.jwt.generateToken(
      {
        user_id: '3dbcc8d0-6666-4359-8f60-211277d27326',
        user_name: 'tester',
        first_name: 't',
        last_name: 'e',
        email: 't@example.com',
        is_verified: true,
        permissions: {}
      },
      'access'
    )

    // Reset verifier to expected audience
    // @ts-expect-error allow mutation for test simulation
    authManager.jwt.audience = originalAudience

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest')
    const response = await request(app)
      .post('/protected')
      .set('Authorization', `Bearer ${badToken}`)
      .set('Cookie', 'csrf_token=dummytoken')
      .set('X-CSRF-Token', 'dummytoken')
      .send({})

    expect(response.status).toBe(401)
  })
})
