import { beforeEach, describe, expect, it, vi } from 'vitest'
import { named, reasonOf } from '../app/utils/names'
import { useBeacons, useRide, useStones } from '../app/composables/realm'

// What Nuxt would auto-import, stood in for: the composables are plain functions over these
const toast = { add: vi.fn() }
const refresh = vi.fn()
const $fetch = vi.fn()
const states = new Map<string, { value: unknown }>()

beforeEach(() => {
  toast.add.mockReset()
  refresh.mockReset().mockResolvedValue(undefined)
  $fetch.mockReset()
  states.clear()

  vi.stubGlobal('named', named)
  vi.stubGlobal('reasonOf', reasonOf)
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('$fetch', $fetch)
  vi.stubGlobal('useFetch', vi.fn(() => ({ data: { value: [] }, error: { value: null }, refresh })))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, { value: init() })

    return states.get(key)!
  })
})

describe('useBeacons', () => {
  it('reads the beacons from Anor, empty until they come', () => {
    useBeacons()

    expect(useFetch).toHaveBeenCalledWith('/api/realm/beacons', expect.objectContaining({ default: expect.any(Function) }))
    expect((useFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].default()).toEqual([])
  })

  it('lights a beacon, says who watches for it, and reads the chain again', async () => {
    $fetch.mockResolvedValue({ beacon: 'amon-din', watch_next: 'eilenach' })

    await useBeacons().light('amon-din')

    expect($fetch).toHaveBeenCalledWith('/api/realm/beacons/amon-din/light', { method: 'POST' })
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Amon Dîn burns', description: 'Eilenach watches for it.' }))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('says Rohan has seen it when there is no beacon after', async () => {
    $fetch.mockResolvedValue({ beacon: 'halifirien', watch_next: null })

    await useBeacons().light('halifirien')

    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Rohan has seen it.' }))
  })

  it("toasts the realm's reason when a beacon will not catch, and still reads the chain", async () => {
    $fetch.mockRejectedValue({ data: { detail: 'the realm is in disarray' } })

    await useBeacons().light('halifirien')

    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Halifirien would not catch', description: 'the realm is in disarray', color: 'error' }))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('quenches, and goes on even when Gondor does not answer', async () => {
    $fetch.mockRejectedValue(new Error('down'))

    await useBeacons().quench()

    expect($fetch).toHaveBeenCalledWith('/api/realm/beacons/quench', { method: 'POST' })
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'The beacons are dark' }))
    expect(refresh).toHaveBeenCalledOnce()
  })
})

describe('useStones', () => {
  it('shows what the stone shows', async () => {
    $fetch.mockResolvedValue({ vision: 'Minas Tirith, and a white tree in flower' })

    const stones = useStones()
    const gazing = stones.gaze('anor')

    expect(stones.gazed.value).toBe('anor')
    expect(stones.isGazing.value).toBe(true)

    await gazing

    expect($fetch).toHaveBeenCalledWith('/api/realm/palantiri/anor/gaze')
    expect(stones.vision.value).toBe('Minas Tirith, and a white tree in flower')
    expect(stones.isDark.value).toBe(false)
    expect(stones.isGazing.value).toBe(false)
  })

  it('shows the reason and goes dark when the stone is held', async () => {
    $fetch.mockRejectedValue({ data: { detail: 'the realm is in disarray' } })

    const stones = useStones()

    await stones.gaze('ithil')

    expect(stones.vision.value).toBe('the realm is in disarray')
    expect(stones.isDark.value).toBe(true)
    expect(stones.isGazing.value).toBe(false)
  })

  it('clears the dark once a stone shows something again', async () => {
    const stones = useStones()

    $fetch.mockRejectedValueOnce({})
    await stones.gaze('ithil')
    $fetch.mockResolvedValueOnce({ vision: 'the Sea' })
    await stones.gaze('elostirion')

    expect(stones.isDark.value).toBe(false)
  })

  it('shares one stone between the list and the map', () => {
    expect(useStones().gazed).toBe(useStones().gazed)
  })
})

describe('useRide', () => {
  it('is empty until Rohan rides, and shared', () => {
    expect(useRide().value).toBeNull()
    expect(useRide()).toBe(useRide())
  })
})
