import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useTurnstile } from '../../app/composables/useTurnstile'

function createHarness() {
  const scope = effectScope()
  const container = shallowRef({} as HTMLElement)
  let callbacks: Record<string, unknown> = {}
  const api = {
    render: vi.fn((_container, options) => {
      callbacks = options
      return 'login-widget'
    }),
    execute: vi.fn(),
    reset: vi.fn(),
    remove: vi.fn(),
  }
  vi.stubGlobal('window', { turnstile: api })
  const state = scope.run(() => useTurnstile(container, '0x4AAAAAAFqooGiVlr3WrzGw'))!
  return {
    scope,
    container,
    state,
    api,
    success: (token: string) => (callbacks.callback as (token: string) => void)(token),
    fail: (name: string) => (callbacks[name] as () => void)(),
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useTurnstile', () => {
  it('executes only on demand and resolves only after the challenge succeeds', async () => {
    const { state, api, success, scope } = createHarness()
    expect(api.render).not.toHaveBeenCalled()
    expect(api.execute).not.toHaveBeenCalled()

    const verification = state.execute()
    await flushPromises()
    expect(api.render).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      'sitekey': '0x4AAAAAAFqooGiVlr3WrzGw',
      'action': 'turnstile-spin-v2',
      'execution': 'execute',
      'appearance': 'execute',
      'retry': 'never',
      'response-field': false,
    }))
    expect(api.execute).toHaveBeenCalledWith('login-widget')

    success('fresh-token')
    await expect(verification).resolves.toBe('fresh-token')
    state.reset()
    expect(api.reset).toHaveBeenCalledWith('login-widget')
    scope.stop()
    expect(api.remove).toHaveBeenCalledWith('login-widget')
  })

  it('does not leave the form stuck if the challenge never calls back', async () => {
    vi.useFakeTimers()
    const { state, scope } = createHarness()
    const verification = state.execute()
    const rejected = expect(verification).rejects.toThrow()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(300_000)
    await rejected
    scope.stop()
  })

  it('does not reset a widget after navigation has removed it', async () => {
    const { state, api, scope, success } = createHarness()
    const verification = state.execute()
    await flushPromises()
    success('fresh-token')
    await verification
    scope.stop()
    state.reset()
    expect(api.remove).toHaveBeenCalledWith('login-widget')
    expect(api.reset).not.toHaveBeenCalled()
  })

  it.each(['error-callback', 'expired-callback', 'timeout-callback', 'unsupported-callback'])('allows a fresh retry after %s', async (callback) => {
    const { state, api, scope, fail, success } = createHarness()
    const first = state.execute()
    const rejected = expect(first).rejects.toThrow()
    await flushPromises()
    fail(callback)
    await rejected
    state.reset()
    const retry = state.execute()
    await flushPromises()
    success('retry-token')
    await expect(retry).resolves.toBe('retry-token')
    expect(api.render).toHaveBeenCalledTimes(2)
    expect(api.execute).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('deduplicates pending executions and cancels on unmount', async () => {
    const { state, api, scope, success } = createHarness()
    const pending = state.execute()
    const rejected = expect(pending).rejects.toThrow('cancelled')
    expect(state.execute()).toBe(pending)
    await flushPromises()
    expect(api.execute).toHaveBeenCalledOnce()
    scope.stop()
    await rejected
    success('late-token')
    await expect(state.execute()).rejects.toThrow('unavailable')
  })

  it('loads the explicit-render script lazily and waits before rendering', async () => {
    const { state, api, scope, success } = createHarness()
    const script = { src: '', async: false, defer: false, onload: undefined as (() => void) | undefined, remove: vi.fn() }
    const appendChild = vi.fn()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { createElement: () => script, head: { appendChild } })
    expect(appendChild).not.toHaveBeenCalled()
    const verification = state.execute()
    expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    expect(script.async && script.defer).toBe(true)
    expect(api.render).not.toHaveBeenCalled()
    Object.assign(window, { turnstile: api })
    script.onload?.()
    await flushPromises()
    success('loaded-token')
    await expect(verification).resolves.toBe('loaded-token')
    scope.stop()
  })

  it('fails closed when the script never loads and permits another load', async () => {
    vi.useFakeTimers()
    const { state, api, scope, success } = createHarness()
    const script = { onload: undefined as (() => void) | undefined, remove: vi.fn() }
    const createElement = vi.fn(() => script)
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { createElement, head: { appendChild: vi.fn() } })
    const first = state.execute()
    const rejected = expect(first).rejects.toThrow('Unable to load')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(script.remove).toHaveBeenCalledOnce()
    const retry = state.execute()
    expect(createElement).toHaveBeenCalledTimes(2)
    Object.assign(window, { turnstile: api })
    script.onload?.()
    await flushPromises()
    success('retry-token')
    await expect(retry).resolves.toBe('retry-token')
    scope.stop()
  })
})
