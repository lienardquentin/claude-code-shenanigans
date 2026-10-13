// Why a component rendered again is told to Anor's server, which logs it: Vue says it to the component alone, and
// only in development, which is the only place this runs
export default defineNuxtPlugin(nuxtApp => {
  if (!import.meta.dev) return

  reportRenders(nuxtApp.vueApp, renders => {
    void $fetch('/api/renders', { method: 'POST', body: { renders } }).catch(() => undefined)
  })
})
