// Anor asks Gondor for everything through its own server, so that what the page does is in a log
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  devtools: { enabled: false },
  // Nothing of this project is sent anywhere, and nothing it draws with is fetched: no telemetry, no web fonts
  // (the reader's own serif does), and the icons come from the set installed beside it
  telemetry: false,
  ui: { fonts: false },
  icon: { fallbackToApi: false },
  // Night over the White Mountains, whatever the reader's system says
  colorMode: { preference: 'dark', fallback: 'dark' },
  css: ['~/assets/css/main.css'],
  // NUXT_GONDOR_URL names another Gondor
  runtimeConfig: { gondorUrl: 'http://127.0.0.1:8101' },
  app: { head: { title: "Anor · the Steward's stone", htmlAttrs: { lang: 'en' } } },
})
