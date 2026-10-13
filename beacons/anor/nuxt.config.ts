// Anor asks Gondor for everything through its own server, so that what the page does is in a log
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  devtools: { enabled: false },
  // Nothing it draws with is fetched: no telemetry of Nuxt's, no web fonts (the reader's own serif does), and the
  // icons come from the set installed beside it. The map is the one exception: Mapbox checks its token, and counts
  // each time a map is loaded
  telemetry: false,
  ui: { fonts: false },
  icon: { fallbackToApi: false },
  // Night over the White Mountains, whatever the reader's system says
  colorMode: { preference: 'dark', fallback: 'dark' },
  css: ['~/assets/css/main.css'],
  // NUXT_GONDOR_URL names another Gondor. NUXT_PUBLIC_MAPBOX_TOKEN is the map's: a public token (pk.…), which
  // the page itself holds
  runtimeConfig: { gondorUrl: 'http://127.0.0.1:8101', public: { mapboxToken: '' } },
  app: { head: { title: "Anor · the Steward's stone", htmlAttrs: { lang: 'en' } } },
})
