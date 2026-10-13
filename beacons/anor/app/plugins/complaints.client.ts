// An error in the page is told to Anor's server, which logs it: a browser's console is in nobody's log
export default defineNuxtPlugin(nuxtApp => {
  const complain = (error: unknown, where: string) => {
    const raised = error instanceof Error ? error : new Error(String(error))

    void $fetch('/api/complaints', { method: 'POST', body: { message: `${raised.name}: ${raised.message}`, stack: raised.stack ?? '', where } }).catch(() => undefined)
  }

  nuxtApp.hook('vue:error', (error, _instance, info) => complain(error, String(info)))
  window.addEventListener('unhandledrejection', event => complain(event.reason, 'unhandled rejection'))
})
