type Beacon = { beacon: string; lit: boolean }
type Lit = { beacon: string; watch_next: string | null }
type Ride = { riding: number; days: number }

const none = (): Beacon[] => []

/** The beacons and the lighting of them: the chain and the map hold the same ones. */
export const useBeacons = () => {
  const { data: beacons, error, refresh } = useFetch<Beacon[]>('/api/realm/beacons', { default: none })
  const toast = useToast()

  const light = async (name: string) => {
    try {
      const lit = await $fetch<Lit>(`/api/realm/beacons/${name}/light`, { method: 'POST' })

      toast.add({
        title: `${named(name)} burns`,
        description: lit.watch_next ? `${named(lit.watch_next)} watches for it.` : 'Rohan has seen it.',
        icon: 'i-lucide-flame',
        color: 'primary',
      })
    } catch (failure) {
      toast.add({ title: `${named(name)} would not catch`, description: reasonOf(failure), icon: 'i-lucide-cloud-rain', color: 'error' })
    }

    await refresh()
  }

  const quench = async () => {
    await $fetch('/api/realm/beacons/quench', { method: 'POST' }).catch(() => undefined)
    toast.add({ title: 'The beacons are dark', icon: 'i-lucide-moon', color: 'neutral' })
    await refresh()
  }

  return { beacons, error, refresh, light, quench }
}

/** The stone being looked into and what it shows, whether it was chosen from the list or on the map. */
export const useStones = () => {
  const gazed = useState('stone-gazed', () => '')
  const vision = useState('stone-vision', () => '')
  const isDark = useState('stone-dark', () => false)
  const isGazing = useState('stone-gazing', () => false)

  const gaze = async (stone: string) => {
    gazed.value = stone
    isGazing.value = true

    try {
      const seen = await $fetch<{ vision: string }>(`/api/realm/palantiri/${stone}/gaze`)

      vision.value = seen.vision
      isDark.value = false
    } catch (failure) {
      vision.value = reasonOf(failure)
      isDark.value = true
    } finally {
      isGazing.value = false
    }
  }

  return { gazed, vision, isDark, isGazing, gaze }
}

/** Rohan's last answer to the Red Arrow: the map sets the riders on the road when it changes. */
export const useRide = () => useState<Ride | null>('ride', () => null)
