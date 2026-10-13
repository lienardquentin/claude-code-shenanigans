// The page as it stands is told to the app's own server, which logs it: nothing outside the browser can see it.
// Only in development, and only once the page is drawn
export default defineNuxtPlugin(nuxtApp => {
  if (!import.meta.dev) return

  nuxtApp.hook('app:mounted', () => {
    reportDom(dom => {
      void $fetch('/api/dom', { method: 'POST', body: dom }).catch(() => undefined)
    })
  })
})
