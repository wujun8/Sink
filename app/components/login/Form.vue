<script setup lang="ts">
import { AlertCircle, Loader2 } from '@lucide/vue'
import { z } from 'zod'

const { t } = useI18n()
const { previewMode, turnstileSiteKey } = useRuntimeConfig().public

const token = shallowRef('')
const error = shallowRef('')
const submitError = shallowRef('')
const isSubmitting = shallowRef(false)
const isVerifying = shallowRef(false)
const turnstileContainer = useTemplateRef('turnstileContainer')
const turnstile = useTurnstile(turnstileContainer, turnstileSiteKey)

const LoginSchema = z.object({
  token: z.string().min(1),
})

watch(token, () => {
  error.value = ''
  submitError.value = ''
})

async function handleSubmit() {
  if (isSubmitting.value)
    return

  error.value = ''
  submitError.value = ''
  const result = LoginSchema.safeParse({ token: token.value })

  if (!result.success) {
    error.value = t('login.token_required')
    await nextTick()
    document.getElementById('token')?.focus()
    return
  }

  try {
    isSubmitting.value = true
    isVerifying.value = true
    const challengeToken = await turnstile.execute()
    isVerifying.value = false
    await useAPI('/api/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.data.token}` },
      body: { 'cf-turnstile-response': challengeToken },
      retry: 0,
    })
    setAuthToken(result.data.token)
    await navigateTo('/dashboard')
  }
  catch (e) {
    removeAuthToken()
    console.error(e)
    const status = typeof e === 'object' && e !== null && 'status' in e ? e.status : undefined
    submitError.value = t(isVerifying.value || status === 403 || status === 503 ? 'login.verification_failed' : 'login.failed')
  }
  finally {
    turnstile.reset()
    isVerifying.value = false
    isSubmitting.value = false
  }
}
</script>

<template>
  <form class="space-y-6" :aria-busy="isSubmitting" @submit.prevent="handleSubmit">
    <Input
      type="text"
      name="username"
      autocomplete="username"
      value="root"
      readonly
      class="sr-only size-px min-h-px min-w-px p-0"
      tabindex="-1"
      aria-hidden="true"
    />
    <FieldGroup>
      <Field :data-invalid="!!error">
        <FieldLabel for="token">
          {{ $t('login.token_label') }}
        </FieldLabel>
        <Input
          id="token"
          v-model="token"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="********"
          :aria-invalid="!!error"
          :aria-describedby="error ? 'token-error' : undefined"
          autocapitalize="none"
          spellcheck="false"
          :disabled="isSubmitting"
        />
        <FieldError v-if="error" id="token-error" :errors="[error]" />
      </Field>
    </FieldGroup>

    <div
      v-show="isSubmitting"
      ref="turnstileContainer"
      class="flex justify-center"
      :data-sitekey="turnstileSiteKey"
      data-action="turnstile-spin-v2"
    />

    <Alert v-if="submitError" variant="destructive" role="alert">
      <AlertCircle aria-hidden="true" class="size-4" />
      <AlertTitle>{{ submitError }}</AlertTitle>
    </Alert>

    <Alert v-if="previewMode">
      <AlertCircle aria-hidden="true" class="size-4" />
      <AlertTitle>{{ $t('login.tips') }}</AlertTitle>
      <AlertDescription>
        {{ $t('login.preview_token') }}
        <code
          class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground"
        >SinkCool</code>
      </AlertDescription>
    </Alert>

    <Button
      class="w-full"
      type="submit"
      :disabled="isSubmitting"
      :aria-busy="isSubmitting"
    >
      <Loader2
        v-if="isSubmitting" aria-hidden="true" class="motion-safe:animate-spin"
      />
      {{ $t(isVerifying ? 'login.verifying' : isSubmitting ? 'login.logging_in' : 'login.submit') }}
    </Button>
  </form>
</template>
