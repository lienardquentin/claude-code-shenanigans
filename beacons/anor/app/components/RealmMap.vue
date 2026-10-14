<script setup lang="ts">
import 'mapbox-gl/dist/mapbox-gl.css'
import type { Feature } from 'geojson'
import type { GeoJSONSource, Map as Chart } from 'mapbox-gl'

const RIDE_MS = 9000

const { mapboxToken } = useRuntimeConfig().public
const { beacons, light } = useBeacons()
const askKeeper = useKeeperPrompt()
const { gazed, gaze } = useStones()
const ride = useRide()

const sheet = useTemplateRef<HTMLElement>('sheet')
const trouble = ref('')
let chart: Chart | undefined
let riding = 0

const draw = (source: string, features: Feature[]) => chart?.getSource<GeoJSONSource>(source)?.setData({ type: 'FeatureCollection', features })

const drawBeacons = () => {
  const lit = new Set(beacons.value.filter(beacon => beacon.lit).map(({ beacon }) => beacon))

  draw(
    'beacons',
    Object.entries(BEACON_HILLS).map(([name, hill]) => ({
      type: 'Feature',
      properties: { name, label: named(name), lit: lit.has(name) },
      geometry: { type: 'Point', coordinates: at(hill) },
    })),
  )
  draw('relay', [relayOf(lit)])
}

// The Rohirrim go down the Great West Road; a reader who asked for stillness finds them already at the Gate
const rideOut = () => {
  if (!ride.value) return

  const label = `${ride.value.riding.toLocaleString('en')} spears`
  const isStill = matchMedia('(prefers-reduced-motion: reduce)').matches
  const started = performance.now()

  const step = (now: number) => {
    const part = isStill ? 1 : Math.min((now - started) / RIDE_MS, 1)

    draw('riders', [{ type: 'Feature', properties: { label }, geometry: { type: 'Point', coordinates: onTheRoad(part) } }])

    if (part < 1) riding = requestAnimationFrame(step)
  }

  cancelAnimationFrame(riding)
  chart?.fitBounds(VIEWS.beacons, { padding: 24 })
  riding = requestAnimationFrame(step)
}

// A beacon-hill is lit once someone says who lights it; called off, it stays dark
const kindle = async (beacon: string) => {
  const keeper = await askKeeper(beacon)

  if (keeper !== undefined) await light(beacon, keeper)
}

const show = (view: keyof typeof VIEWS) => chart?.fitBounds(VIEWS[view], { padding: 24 })

onMounted(async () => {
  if (!sheet.value) return

  const { default: mapboxgl } = await import('mapbox-gl')
  const palette = paletteOf(sheet.value)

  chart = new mapboxgl.Map({
    container: sheet.value,
    accessToken: mapboxToken,
    style: styleOf(palette),
    projection: 'mercator',
    // No font is fetched for the map either: its names are drawn in the page's serif
    localFontFamily: getComputedStyle(sheet.value).fontFamily,
    bounds: VIEWS.beacons,
    fitBoundsOptions: { padding: 24 },
    maxBounds: VIEWS.middleEarth,
    maxZoom: 9,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  })

  chart.touchZoomRotate.disableRotation()
  chart.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-right')
  chart.on('styleimagemissing', ({ id }) => {
    if (id === 'peak' && !chart?.hasImage('peak')) chart?.addImage('peak', peakOf(palette), { pixelRatio: 2 })
  })
  chart.on('error', ({ error }) => {
    trouble.value = error.message
  })

  for (const layer of ['beacons', 'stones']) {
    chart.on('mouseenter', layer, () => {
      chart!.getCanvas().style.cursor = 'pointer'
    })
    chart.on('mouseleave', layer, () => {
      chart!.getCanvas().style.cursor = ''
    })
  }

  // A fingertip is wider than a beacon: the click takes what lies within a few pixels, the topmost first
  chart.on('click', ({ point }) => {
    const touched = chart!
      .queryRenderedFeatures([[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]], { layers: ['beacons', 'stones'] })
      .at(0)

    if (touched?.layer?.id === 'beacons') void kindle(String(touched.properties?.name))
    else if (touched) void gaze(String(touched.properties?.stone))
  })

  chart.on('load', () => {
    drawBeacons()
    rideOut()
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(riding)
  chart?.remove()
})

watch(beacons, drawBeacons, { deep: true })
watch(ride, rideOut)
// The eye goes where the stone is, however far: Elostirion is a long way from the White Tower
watch(gazed, stone => {
  const seat = STONE_SEATS[stone]

  if (seat) chart?.flyTo({ center: at(seat) as [number, number], zoom: 6.5 })
})
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg tracking-wide text-highlighted">The realm</h2>
        <div v-if="mapboxToken" class="flex gap-1">
          <UButton label="The beacons" icon="i-lucide-flame" color="neutral" variant="ghost" size="sm" @click="show('beacons')" />
          <UButton label="All Middle-earth" icon="i-lucide-map" color="neutral" variant="ghost" size="sm" @click="show('middleEarth')" />
        </div>
      </div>
    </template>

    <div v-if="!mapboxToken" class="p-4 sm:p-6">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-scroll"
        title="The map is still rolled up"
        description="Set NUXT_PUBLIC_MAPBOX_TOKEN in anor/.env to a Mapbox public token, and start Anor again."
      />
    </div>
    <template v-else>
      <div v-if="trouble" class="p-4 sm:p-6">
        <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" title="The map will not unroll" :description="trouble" />
      </div>
      <div ref="sheet" class="h-96 sm:h-[30rem]" role="application" aria-label="A map of Middle-earth: the beacons from Minas Tirith to Rohan, and the seats of the seeing-stones" />
    </template>

    <template #footer>
      <p class="text-sm italic text-muted">Touch a beacon-hill to light it, a ringed stone to look into it. When Rohan answers, its spears take the road.</p>
    </template>
  </UCard>
</template>
