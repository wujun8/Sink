import type { H3Event } from 'h3'
import process from 'node:process'

export async function verifyLoginTurnstile(event: H3Event): Promise<void> {
  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  const token = body?.['cf-turnstile-response']
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    throw createError({
      status: 403,
      statusText: 'Human verification failed',
    })
  }

  const config = useRuntimeConfig(event)
  const secret = event.context.cloudflare?.env?.TURNSTILE_SECRET
    || config.turnstileSecret || process.env.TURNSTILE_SECRET
  const hostnames = new Set(config.turnstileHostnames.split(',').map(hostname => hostname.trim()).filter(Boolean))
  if (typeof secret !== 'string' || !secret.trim() || hostnames.size === 0) {
    throw createError({
      status: 503,
      statusText: 'Human verification is not configured',
    })
  }

  let verified = false
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: getHeader(event, 'CF-Connecting-IP') || '',
      }),
    })
    if (response.ok) {
      const result = await response.json() as { success?: boolean, action?: string, hostname?: string } | null
      verified = result?.success === true
        && result.action === 'turnstile-spin-v2'
        && typeof result.hostname === 'string' && hostnames.has(result.hostname)
    }
  }
  catch {
    verified = false
  }

  if (!verified) {
    throw createError({
      status: 403,
      statusText: 'Human verification failed',
    })
  }
}
