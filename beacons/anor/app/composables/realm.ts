type Beacon = { beacon: string; lit: boolean; keeper: string | null; since: string | null }
type Lit = { beacon: string; watch_next: string | null; keeper: string | null }
type Ride = { riding: number; days: number }

const none = (): Beacon[] => []

const KEPT_AS = 'anor-keeper'

/** The last name a beacon was lit under, kept across visits so that the prompt offers it again. */
export const useKeeper = () => {
  const keeper = useState<string | null>('keeper', () => null)

  // The server has no storage: what this browser kept is read the first time it is asked for
  const recall = (): string => {
    if (keeper.value === null) keeper.value = (typeof localStorage === 'undefined' ? null : localStorage.getItem(KEPT_AS)) ?? ''

    return keeper.value
  }

  const remember = (name: string) => {
    keeper.value = name

    if (typeof localStorage !== 'undefined') localStorage.setItem(KEPT_AS, name)
  }

  return { recall, remember }
}

/** Asks who lights a beacon: their name, empty for no one in particular, or undefined when the lighting is called off. */
export const useKeeperPrompt = () => {
  const overlay = useOverlay()
  const KeeperPrompt = defineAsyncComponent(() => import('../components/KeeperPrompt.vue'))
  const { recall } = useKeeper()

  return async (beacon: string): Promise<string | undefined> => {
    // An overlay of its own each time, taken away once it has closed: the chain and the map mounting again leave none behind
    const prompt = overlay.create(KeeperPrompt, { destroyOnClose: true })
    const answer: unknown = await prompt.open({ beacon, keeper: recall() })

    return typeof answer === 'string' ? answer : undefined
  }
}

/** The beacons and the lighting of them: the chain and the map hold the same ones. */
export const useBeacons = () => {
  const { data: beacons, error, refresh } = useFetch<Beacon[]>('/api/realm/beacons', { default: none })
  const toast = useToast()
  const { remember } = useKeeper()

  const light = async (name: string, keeper?: string) => {
    const who = keeper?.trim() || null

    try {
      const lit = await $fetch<Lit>(`/api/realm/beacons/${name}/light`, { method: 'POST', body: { keeper: who } })

      // The name is offered again once a fire was lit under it: an unnamed or a failed lighting leaves it as it was
      if (who) remember(who)

      const watched = lit.watch_next ? `${named(lit.watch_next)} watches for it.` : 'Rohan has seen it.'

      toast.add({
        title: `${named(name)} burns`,
        description: who ? `${who} lit it. ${watched}` : watched,
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
