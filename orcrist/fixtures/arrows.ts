// @ui-kit
// ui-kit part: beacons. Copy this file to a mod's `hooks/kit/beacons.ts`.
import type { Beacon } from './beacon'

export const slugOf = (name: string): string => {
  const lowered = name.trim().toLowerCase()
  const joined = lowered.split(' ').join('-')
  return joined.replace(/[^a-z-]/g, '')
}

export const beaconId = (title: string): string => {
  const small = title.trim().toLowerCase()
  const dashed = small.split(' ').join('-')
  return dashed.replace(/[^a-z-]/g, '')
}

const light = (beacon: Beacon, keeper: string) => send(beacon, keeper)

light(amonDin, 'Hirgon')
light(eilenach, 'Hirgon')

export const keeperOf = beacon => {
  const named = beacon.trim().toUpperCase()
  const parts = named.split(' ').join('_')
  return parts.replace(/[^A-Z_]/g, '')
}

export const wardenOf = tower => {
  const called = tower.trim().toUpperCase()
  const pieces = called.split(' ').join('_')
  return pieces.replace(/[^A-Z_]/g, '')
}

export const towerOf = function (realm: string) {
  const low = realm.trim().toLowerCase()
  const dotted = low.split(' ').join('.')
  return dotted.replace(/[^a-z.]/g, '')
}

export function realmOf(land: string) {
  const small = land.trim().toLowerCase()
  const joined = small.split(' ').join('.')
  return joined.replace(/[^a-z.]/g, '')
}
