import type { LayerSpecification, StyleSpecification } from 'mapbox-gl'

// The map is drawn in the theme's own colors, mixed where it needs a tint: none is written here as a value
const INKS = {
  sea: 'var(--ui-bg)',
  land: 'var(--ui-bg-elevated)',
  coast: 'var(--ui-border-accented)',
  shadow: 'color-mix(in srgb, var(--ui-error) 14%, var(--ui-bg-elevated))',
  forest: 'color-mix(in srgb, var(--ui-success) 16%, var(--ui-bg-elevated))',
  water: 'color-mix(in srgb, var(--ui-info) 45%, var(--ui-bg))',
  road: 'var(--ui-text-dimmed)',
  rock: 'var(--ui-border-accented)',
  snow: 'var(--ui-text-highlighted)',
  text: 'var(--ui-text-muted)',
  name: 'var(--ui-text-highlighted)',
  faint: 'var(--ui-text-dimmed)',
  fire: 'var(--ui-primary)',
  glow: 'color-mix(in srgb, var(--ui-primary) 45%, transparent)',
  stone: 'var(--ui-info)',
  riders: 'var(--ui-success)',
}

export type Palette = Record<keyof typeof INKS, string>

/**
 * The theme's colors as the map can take them. A style reads neither a CSS variable nor oklch, so each ink is put
 * on a hidden element, painted on one pixel and read back.
 */
export const paletteOf = (within: HTMLElement): Palette => {
  const probe = within.appendChild(document.createElement('i'))
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!

  const read = (ink: string) => {
    probe.style.color = ink
    pixel.clearRect(0, 0, 1, 1)
    pixel.fillStyle = getComputedStyle(probe).color
    pixel.fillRect(0, 0, 1, 1)

    const [red, green, blue, alpha = 255] = pixel.getImageData(0, 0, 1, 1).data

    return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
  }

  const palette = Object.fromEntries(Object.entries(INKS).map(([name, ink]) => [name, read(ink)])) as Palette

  probe.remove()

  return palette
}

/** A snow-capped peak, the one the beacon chain draws, for the ranges to be strung with. */
export const peakOf = ({ rock, snow }: Palette): ImageData => {
  const [width, height] = [28, 24]
  const pen = Object.assign(document.createElement('canvas'), { width, height }).getContext('2d')!

  pen.beginPath()
  pen.moveTo(width / 2, 0)
  pen.lineTo(width, height)
  pen.lineTo(0, height)
  pen.clip()
  pen.fillStyle = rock
  pen.fillRect(0, 0, width, height)
  pen.fillStyle = snow
  pen.fillRect(0, 0, width, height * 0.22)

  return pen.getImageData(0, 0, width, height)
}

const NOTHING = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as const
const sizeByZoom = (small: number, large: number) => ['interpolate', ['linear'], ['zoom'], 4, small, 8, large]

/** Middle-earth as a style: nothing in it is a tile, every source is what Anor itself holds. */
export const styleOf = (ink: Palette): StyleSpecification => {
  const kind = (name: string) => ['==', ['get', 'kind'], name]
  const ranked = (name: string, rank: number) => ['all', kind(name), ['==', ['coalesce', ['get', 'rank'], 1], rank]]
  const lettering = { 'text-field': ['get', 'label'], 'text-size': sizeByZoom(11, 14) }
  const haloed = (color: string) => ({ 'text-color': color, 'text-halo-color': ink.sea, 'text-halo-width': 1.2 })

  const places = (rank: number) => [
    { id: `places-${rank}`, type: 'circle', source: 'realm', minzoom: rank === 1 ? 0 : 5.5, filter: ranked('place', rank), paint: { 'circle-radius': rank === 1 ? 3 : 2, 'circle-color': ink.name } },
    {
      id: `place-names-${rank}`,
      type: 'symbol',
      source: 'realm',
      minzoom: rank === 1 ? 0 : 5.5,
      filter: ranked('place', rank),
      layout: { ...lettering, 'text-anchor': 'top', 'text-offset': [0, 0.5] },
      paint: haloed(rank === 1 ? ink.name : ink.text),
    },
  ]

  const layers = [
    { id: 'sea', type: 'background', paint: { 'background-color': ink.sea } },
    { id: 'land', type: 'fill', source: 'realm', filter: kind('land'), paint: { 'fill-color': ink.land } },
    { id: 'coast', type: 'line', source: 'realm', filter: kind('land'), paint: { 'line-color': ink.coast, 'line-width': 1 } },
    { id: 'shadow', type: 'fill', source: 'realm', filter: kind('shadow'), paint: { 'fill-color': ink.shadow } },
    { id: 'forests', type: 'fill', source: 'realm', filter: kind('forest'), paint: { 'fill-color': ink.forest } },
    { id: 'lakes', type: 'fill', source: 'realm', filter: kind('lake'), paint: { 'fill-color': ink.water, 'fill-opacity': 0.5 } },
    { id: 'rivers', type: 'line', source: 'realm', filter: kind('river'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ink.water, 'line-width': sizeByZoom(1, 3) } },
    { id: 'roads', type: 'line', source: 'realm', filter: kind('road'), paint: { 'line-color': ink.road, 'line-width': 1, 'line-dasharray': [3, 3] } },
    { id: 'range-roots', type: 'line', source: 'realm', filter: kind('range'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ink.rock, 'line-width': sizeByZoom(5, 16), 'line-blur': sizeByZoom(3, 8), 'line-opacity': 0.55 } },
    {
      id: 'ranges',
      type: 'symbol',
      source: 'realm',
      filter: kind('range'),
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 14, 'icon-image': 'peak', 'icon-size': sizeByZoom(0.8, 1.5), 'icon-padding': 0, 'icon-rotation-alignment': 'viewport', 'icon-allow-overlap': true },
    },

    { id: 'relay', type: 'line', source: 'relay', layout: { 'line-cap': 'round' }, paint: { 'line-color': ink.fire, 'line-width': 2, 'line-blur': 1 } },

    { id: 'river-names', type: 'symbol', source: 'realm', minzoom: 5, filter: kind('river'), layout: { ...lettering, 'symbol-placement': 'line', 'text-offset': [0, -0.8], 'text-size': 11 }, paint: haloed(ink.water) },
    { id: 'range-names', type: 'symbol', source: 'realm', filter: kind('range'), layout: { ...lettering, 'symbol-placement': 'line', 'text-offset': [0, 1.4], 'text-letter-spacing': 0.15 }, paint: haloed(ink.text) },
    { id: 'forest-names-1', type: 'symbol', source: 'realm', filter: ranked('forest', 1), layout: { ...lettering, 'text-size': 11 }, paint: haloed(ink.text) },
    { id: 'forest-names-2', type: 'symbol', source: 'realm', minzoom: 6.5, filter: ranked('forest', 2), layout: { ...lettering, 'text-size': 11 }, paint: haloed(ink.text) },
    { id: 'sea-names', type: 'symbol', source: 'realm', filter: kind('sea'), layout: { ...lettering, 'text-letter-spacing': 0.1 }, paint: haloed(ink.water) },
    { id: 'regions', type: 'symbol', source: 'realm', maxzoom: 7.5, filter: kind('region'), layout: { ...lettering, 'text-size': sizeByZoom(13, 22), 'text-letter-spacing': 0.35 }, paint: { 'text-color': ink.faint } },
    // The lesser places first: where two names would meet, the one drawn last keeps its ground
    ...places(2),
    ...places(1),

    { id: 'stones', type: 'circle', source: 'realm', filter: kind('stone'), paint: { 'circle-radius': sizeByZoom(3, 8), 'circle-color': ink.sea, 'circle-stroke-color': ink.stone, 'circle-stroke-width': 2 } },

    { id: 'beacon-glow', type: 'circle', source: 'beacons', filter: ['get', 'lit'], paint: { 'circle-radius': sizeByZoom(9, 22), 'circle-color': ink.glow, 'circle-blur': 1 } },
    {
      id: 'beacons',
      type: 'circle',
      source: 'beacons',
      paint: { 'circle-radius': sizeByZoom(3, 6), 'circle-color': ['case', ['get', 'lit'], ink.fire, ink.text], 'circle-stroke-color': ink.sea, 'circle-stroke-width': 1 },
    },
    {
      id: 'beacon-names',
      type: 'symbol',
      source: 'beacons',
      minzoom: 6.5,
      layout: { ...lettering, 'text-size': 11, 'text-variable-anchor': ['bottom', 'top'], 'text-radial-offset': 0.9 },
      paint: { ...haloed(ink.text), 'text-color': ['case', ['get', 'lit'], ink.fire, ink.text] },
    },

    { id: 'riders-glow', type: 'circle', source: 'riders', paint: { 'circle-radius': 12, 'circle-color': ink.riders, 'circle-blur': 1, 'circle-opacity': 0.5 } },
    { id: 'riders', type: 'circle', source: 'riders', paint: { 'circle-radius': 4, 'circle-color': ink.riders, 'circle-stroke-color': ink.sea, 'circle-stroke-width': 1 } },
    { id: 'rider-names', type: 'symbol', source: 'riders', layout: { ...lettering, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-allow-overlap': true }, paint: haloed(ink.riders) },
  ]

  return {
    version: 8,
    // Named because a style with lettering must name one, and never asked: the glyphs are drawn from the reader's own serif
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    sources: { realm: { type: 'geojson', data: REALM }, beacons: NOTHING, relay: NOTHING, riders: NOTHING },
    // The layers are written as plain objects: an expression is a tuple the compiler cannot infer from a literal
    layers: layers as LayerSpecification[],
  }
}
