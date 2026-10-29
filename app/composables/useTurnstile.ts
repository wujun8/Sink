import type { Ref } from 'vue'
import { onScopeDispose } from 'vue'

interface TurnstileOptions {
  'sitekey': string
  'action': string
  'execution': 'execute'
  'appearance': 'execute'
  'size': 'flexible'
  'retry': 'never'
  'refresh-expired': 'manual'
  'refresh-timeout': 'manual'
  'response-field': false
  'callback': (token: string) => void
  'error-callback': () => boolean
  'expired-callback': () => void
  'timeout-callback': () => void
  'unsupported-callback': () => void
}

interface TurnstileAPI {
  render: (container: HTMLElement, options: TurnstileOptions) => string | undefined
  execute: (widgetId: string) => void
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI
  }
}

let scriptPromise: Promise<TurnstileAPI> | undefined

function loadTurnstile(): Promise<TurnstileAPI> {
  if (window.turnstile)
    return Promise.resolve(window.turnstile)
  if (scriptPromise)
    return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const timeout = setTimeout(fail, 15_000)
    function fail() {
      clearTimeout(timeout)
      script.remove()
      reject(new Error('Unable to load human verification'))
    }
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => {
      clearTimeout(timeout)
      if (window.turnstile)
        resolve(window.turnstile)
      else
        fail()
    }
    script.onerror = fail
    document.head.appendChild(script)
  })
  const loading = scriptPromise
  void loading.then(
    () => { scriptPromise = undefined },
    () => { scriptPromise = undefined },
  )
  return loading
}

export function useTurnstile(container: Ref<HTMLElement | null>, sitekey: string) {
  let api: TurnstileAPI | undefined
  let widgetId: string | undefined
  let disposed = false
  let pending: { promise: Promise<string>, reject: (error: Error) => void, timeout: ReturnType<typeof setTimeout> } | undefined

  function execute(): Promise<string> {
    if (pending)
      return pending.promise
    if (disposed || !container.value || !sitekey.trim())
      return Promise.reject(new Error('Human verification is unavailable'))

    let resolve!: (token: string) => void
    let reject!: (error: Error) => void
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const request = {
      promise,
      reject,
      timeout: setTimeout(() => {
        if (pending !== request)
          return
        pending = undefined
        reject(new Error('Human verification timed out'))
      }, 300_000),
    }
    pending = request

    void loadTurnstile().then((turnstile) => {
      if (pending !== request || disposed || !container.value)
        return
      api = turnstile
      if (widgetId !== undefined)
        api.remove(widgetId)

      function fail() {
        if (pending !== request)
          return
        clearTimeout(request.timeout)
        pending = undefined
        reject(new Error('Human verification failed or expired'))
      }
      widgetId = api.render(container.value, {
        'sitekey': sitekey,
        'action': 'turnstile-spin-v2',
        'execution': 'execute',
        'appearance': 'execute',
        'size': 'flexible',
        'retry': 'never',
        'refresh-expired': 'manual',
        'refresh-timeout': 'manual',
        'response-field': false,
        'callback': (token) => {
          if (pending !== request)
            return
          if (!token) {
            fail()
            return
          }
          clearTimeout(request.timeout)
          pending = undefined
          resolve(token)
        },
        'error-callback': () => {
          fail()
          return true
        },
        'expired-callback': fail,
        'timeout-callback': fail,
        'unsupported-callback': fail,
      })
      if (widgetId === undefined)
        throw new Error('Unable to render human verification')
      api.execute(widgetId)
    }).catch((error: unknown) => {
      if (pending !== request)
        return
      clearTimeout(request.timeout)
      pending = undefined
      reject(error instanceof Error ? error : new Error('Human verification failed'))
    })
    return promise
  }

  function reset() {
    const request = pending
    pending = undefined
    if (request)
      clearTimeout(request.timeout)
    request?.reject(new Error('Human verification cancelled'))
    if (widgetId !== undefined)
      api?.reset(widgetId)
  }

  onScopeDispose(() => {
    disposed = true
    const request = pending
    pending = undefined
    if (request)
      clearTimeout(request.timeout)
    request?.reject(new Error('Human verification cancelled'))
    if (widgetId !== undefined)
      api?.remove(widgetId)
    widgetId = undefined
  })

  return { execute, reset }
}
