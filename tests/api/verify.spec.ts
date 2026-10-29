import type { VerifyResponse } from '../../shared/types/auth'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch, fetchWithAuth } from '../utils'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('/api/verify', () => {
  it('requires an explicit hostname allowlist instead of a deployment default', async () => {
    const originalHostnames = env.NUXT_TURNSTILE_HOSTNAMES
    const bindings = env as unknown as Record<string, unknown>
    delete bindings.NUXT_TURNSTILE_HOSTNAMES
    const siteverify = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      success: true,
      action: 'turnstile-spin-v2',
      hostname: 'bestcf.de5.net',
    }))
    try {
      const response = await fetchWithAuth('/api/verify', {
        method: 'POST',
        body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(response.status).toBe(503)
      expect(siteverify).not.toHaveBeenCalled()
    }
    finally {
      env.NUXT_TURNSTILE_HOSTNAMES = originalHostnames
    }
  })

  it.each(['/api/verify', '/api/verify/', '/api/verify?probe=1'])('requires human verification before a login submission to %s', async (path) => {
    const response = await fetchWithAuth(path, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects a failed Turnstile response before checking the site token', async () => {
    const siteverify = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: false }))
    const response = await fetch('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
    expect(siteverify).toHaveBeenCalledOnce()
  })

  it.each([
    { success: true, action: 'another-form', hostname: 'localhost' },
    { success: true, action: 'turnstile-spin-v2', hostname: 'attacker.example' },
    { success: 'true', action: 'turnstile-spin-v2', hostname: 'localhost' },
    { success: true },
  ])('rejects unexpected verification claims: %j', async (claims) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(claims))
    const response = await fetchWithAuth('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
  })

  it('logs in only after successful server-side verification', async () => {
    const siteverify = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      success: true,
      action: 'turnstile-spin-v2',
      hostname: 'localhost',
    }))
    const response = await fetchWithAuth('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.1',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authMethod: 'site-token', userID: 'root' })
    expect(siteverify).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: expect.any(AbortSignal),
      }),
    )
    const body = siteverify.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(body.get('response')).toBe('challenge-token')
    expect(body.get('remoteip')).toBe('192.0.2.1')
    expect(body.get('secret')).toBe('1x0000000000000000000000000000000AA')
  })

  it.each(['', '   ', 123, {}, 'x'.repeat(2049)])('rejects an invalid challenge token without calling Siteverify: %j', async (token) => {
    const siteverify = vi.spyOn(globalThis, 'fetch')
    const response = await fetchWithAuth('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': token }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
    expect(siteverify).not.toHaveBeenCalled()
  })

  it.each([
    [200, 'invalid JSON'],
    [503, JSON.stringify({ success: true, action: 'turnstile-spin-v2', hostname: 'localhost' })],
  ])('fails closed for an unusable Siteverify response (%s)', async (status, body) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }))
    const response = await fetchWithAuth('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
  })

  it('fails closed when Siteverify is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network unavailable'))
    const response = await fetchWithAuth('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects replay when Siteverify reports a consumed token', async () => {
    const siteverify = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => Response.json({ success: true, action: 'turnstile-spin-v2', hostname: 'localhost' }))
      .mockImplementationOnce(async () => Response.json({ 'success': false, 'error-codes': ['timeout-or-duplicate'] }))
    const options = {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'single-use-token' }),
      headers: { 'Content-Type': 'application/json' },
    }
    expect((await fetchWithAuth('/api/verify', options)).status).toBe(200)
    expect((await fetchWithAuth('/api/verify', options)).status).toBe(403)
    expect(siteverify).toHaveBeenCalledTimes(2)
  })

  it('still rejects invalid credentials after a successful challenge', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      success: true,
      action: 'turnstile-spin-v2',
      hostname: 'localhost',
    }))
    const response = await fetch('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ 'cf-turnstile-response': 'challenge-token' }),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid-token-12345' },
    })
    expect(response.status).toBe(401)
  })

  it('returns the expected verification data with valid auth', async () => {
    const response = await fetchWithAuth('/api/verify')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')

    const data = await response.json() as VerifyResponse
    expect(data).toMatchObject({
      name: 'Sink',
      url: 'https://sink.cool',
      authMethod: 'site-token',
      userID: 'root',
      userEmail: 'root@localhost',
      accessEnabled: false,
    })
  })

  it('returns 401 when accessing without auth', async () => {
    const response = await fetch('/api/verify')
    expect(response.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    const response = await fetch('/api/verify', {
      headers: { Authorization: 'Bearer invalid-token-12345' },
    })
    expect(response.status).toBe(401)
  })

  it('does not trust an Access header when Access is not configured', async () => {
    const response = await fetch('/api/verify', {
      headers: { 'Cf-Access-Jwt-Assertion': 'unsigned-token' },
    })
    expect(response.status).toBe(401)
  })

  it('does not trust an Access cookie when Access is not configured', async () => {
    const response = await fetch('/api/verify', {
      headers: { Cookie: 'CF_Authorization=unsigned-token' },
    })
    expect(response.status).toBe(401)
  })
})
