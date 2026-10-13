import { isReactive, isRef, toRaw } from 'vue'
import type { App, ComponentInternalInstance, DebuggerEvent } from 'vue'

// Why a component rendered again, said as a chain: the state that changed, the computed values and the props that
// carried the change, down to the component, each with the value it held. Vue tells a component what triggered its
// render only in development, and tells nobody else: this listens for every component, and hands the chains over a
// few seconds at a time.
//
// Part of it reads Vue's own bookkeeping (which dependency of a computed value is stale), which Vue 3.5 keeps in
// fields it does not document. Every such read is guarded: where the fields are not there, the chain says less.

/** One chain, and how many times it led to a render since the last handing over. */
export type ReportedRender = {
  /** The component of the app's own source the render belongs to: the one that rendered, or the one it sits in. */
  component: string
  /** The cause first, the component that rendered last: `beacons (ref) set`, `litCount (computed)`, `BeaconChain`. */
  chain: string[]
  /** What each step of the chain held the last time, said briefly: `3 (was 2)`, `true`; null where it is not known. */
  values: (string | null)[]
  /** What a step held, whole, as JSON text, where its short value leaves some of it out; null elsewhere. */
  whole: (string | null)[]
  count: number
}

export type RendersOptions = {
  /** Whether a component file is the app's own; by default, any that is not an installed package's. */
  isOwn?: (file: string) => boolean
  /** How often the chains are handed over, in milliseconds. */
  everyMs?: number
}

// Vue's bookkeeping, as much of it as is read here
type Dep = { computed?: Subscriber; version?: number; key?: unknown }
type Link = { dep?: Dep; version?: number; nextDep?: Link }
type Subscriber = { deps?: Link }

type Instance = ComponentInternalInstance & { devtoolsRawSetupState?: Record<string, unknown> }
type Named = { __name?: string; name?: string; __file?: string }

// A step of a chain: its value is known from the change itself, or read when the chains are handed over. `whole`
// hands what the short value was made from, where the short value leaves some of it out.
type Step = { text: string; value?: string; whole?: () => unknown; read?: () => unknown }
// Whether saying a value shortly left some of it out
type Cut = { is: boolean }
type Binding = { name: string; value: unknown }

const MAX_CHAINS = 30
const MAX_VALUE = 80
const MAX_ITEMS = 4
const MAX_WHOLE = 1500
// A parent's chain is the start of its child's for as long as one round of rendering takes
const SAME_ROUND_MS = 250
// A value that goes by such a name is never said
const SECRET_NAME = /secret|token|passw|credential|api[_-]?key|authorization|cookie/i

const clip = (text: string): string => (text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text)

type Kind = { constructor?: { name?: string } } | null

// Whether what an object is made from makes it a plain one: Vue makes a component's attributes from an object of
// its own, which is one all the same
const isPlain = (kind: Kind): boolean => kind === null || kind === Object.prototype || kind.constructor === Object

// A value in few words, its fields and items to two levels (a list of small objects reads): never the whole of a
// large object
const brief = (value: unknown, depth: number, cut: Cut): string => {
  if (typeof value === 'string') {
    if (value.length > 40) cut.is = true

    return JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value)
  }

  if (typeof value === 'function') return 'a function'
  if (typeof value !== 'object' || value === null) return String(value)

  const raw: object = toRaw(value)

  // What a ref holds is read where Vue keeps it: reading it the usual way here could make a render depend on it
  if (isRef(raw)) return brief((raw as { _value?: unknown })._value, depth, cut)
  if (raw instanceof Date) return raw.toISOString()

  if (Array.isArray(raw)) {
    if (depth > 1 || raw.length > MAX_ITEMS) cut.is = true
    if (depth > 1) return `[${raw.length}]`

    return `[${raw.slice(0, MAX_ITEMS).map(item => brief(item, depth + 1, cut)).join(', ')}${raw.length > MAX_ITEMS ? `, … ${raw.length} in all` : ''}]`
  }

  const kind = Object.getPrototypeOf(raw) as Kind

  // What is not a plain object is said by its kind: an element, a map, a component
  if (!isPlain(kind)) return kind?.constructor?.name ?? 'an object'
  const fields = Object.entries(raw)

  if (depth > 1 || fields.length > MAX_ITEMS) cut.is = true
  if (depth > 1) return '{…}'

  return `{${fields.slice(0, MAX_ITEMS).map(([key, field]) => `${key}: ${SECRET_NAME.test(key) ? '***' : brief(field, depth + 1, cut)}`).join(', ')}${fields.length > MAX_ITEMS ? ', …' : ''}}`
}

/** A value as a chain says it: cut short, with nothing that goes by a secret's name. `cut` is told when some of it is left out. */
export const said = (value: unknown, cut: Cut = { is: false }): string => {
  const text = brief(value, 0, cut)

  if (text.length > MAX_VALUE) cut.is = true

  return clip(text)
}

// A value as data JSON can write, to a depth and a number of items and fields
const plain = (value: unknown, depth: number, most: number): unknown => {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 299)}…` : value
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (typeof value !== 'object' || value === null) return value ?? null

  const raw: object = toRaw(value)

  if (isRef(raw)) return plain((raw as { _value?: unknown })._value, depth, most)
  if (raw instanceof Date) return raw.toISOString()

  if (Array.isArray(raw)) {
    if (depth <= 0) return `[${raw.length}]`

    return [...raw.slice(0, most).map(item => plain(item, depth - 1, most)), ...(raw.length > most ? [`… ${raw.length} in all`] : [])]
  }

  const kind = Object.getPrototypeOf(raw) as Kind

  if (!isPlain(kind)) return kind?.constructor?.name ?? 'an object'
  if (depth <= 0) return '{…}'

  const fields = Object.entries(raw)
  const kept = fields.slice(0, most).map(([key, field]): [string, unknown] => [key, SECRET_NAME.test(key) ? '***' : plain(field, depth - 1, most)])

  return Object.fromEntries(fields.length > most ? [...kept, ['…', `${fields.length} fields in all`]] : kept)
}

/** A value whole, as JSON text: as deep and as long as fits, less of it when it does not; null when nothing fits. */
export const whole = (value: unknown): string | null => {
  for (const [depth, most] of [[5, 40], [3, 12], [2, 5]] as const) {
    const text = JSON.stringify(plain(value, depth, most)) as string | undefined

    if (text !== undefined && text.length <= MAX_WHOLE) return text
  }

  return null
}

const nameOf = (instance: Instance): string => {
  const { __name, name, __file } = instance.type as Named

  return __name ?? name ?? /([^/\\]+)\.\w+$/.exec(__file ?? '')?.[1] ?? 'Anonymous'
}

// A plain object of the app's own, which may hold state under its fields: what a composable handed back whole
const isHolder = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !isRef(value) && !isReactive(value) && Object.getPrototypeOf(value) === Object.prototype

// The one of the named values that is looked for: by its own name, else as a field of one that holds state
const among = (named: readonly (readonly [string, unknown])[], isIt: (value: unknown) => boolean): Binding | undefined => {
  for (const [name, value] of named) {
    try {
      if (isIt(value)) return { name, value }
    } catch {
      // A binding that cannot be looked at is not the one
    }
  }

  for (const [name, value] of named) {
    try {
      if (!isHolder(value)) continue

      for (const [field, inner] of Object.entries(value)) if (isIt(inner)) return { name: `${name}.${field}`, value: inner }
    } catch {
      // Nor is one whose fields cannot be
    }
  }

  return undefined
}

// What the components above provided, the app included, each under the key it was provided by
const providedTo = (instance: Instance): [string, unknown][] => {
  const named: [string, unknown][] = []

  for (let held: object | null = (instance as { provides?: object }).provides ?? null; held !== null && held !== Object.prototype; held = Object.getPrototypeOf(held) as object | null) {
    for (const key of Reflect.ownKeys(held)) named.push([typeof key === 'symbol' ? (key.description ?? 'a symbol') : key, (held as Record<string | symbol, unknown>)[key]])
  }

  return named
}

// What Nuxt keeps for the app, as much of it as is read here: what was fetched, by its key, and the shared state
type Nuxt = { _asyncData?: Record<string, Record<string, unknown> | undefined>; payload?: { state?: object } }

const nuxtOf = (instance: Instance): Nuxt | undefined => (instance.appContext.config.globalProperties as { $nuxt?: Nuxt }).$nuxt

const FETCHED = ['data', 'status', 'error', 'pending'] as const
// The key Nuxt gives a `useFetch` that names none, and the one it keeps a `useState` under
const FETCH_KEY = '$f'
const STATE_KEY = '$s'

// The ref of something fetched, which the component holds only through a computed value: `useFetch data`
const fetchedOf = (instance: Instance, isIt: (value: unknown) => boolean): Binding | undefined => {
  for (const [key, entry] of Object.entries(nuxtOf(instance)?._asyncData ?? {})) {
    for (const field of FETCHED) {
      const value = entry?.[field]

      if (isIt(value)) return { name: `${key.startsWith(FETCH_KEY) ? 'useFetch' : `useAsyncData "${key}"`} ${field}`, value }
    }
  }

  return undefined
}

// The shared state a key is one of, when it is: `useState "cart"`
const sharedOf = (instance: Instance, key: unknown, target?: object): { name: string; state: Record<string, unknown> } | undefined => {
  const state = nuxtOf(instance)?.payload?.state
  const raw = state === undefined ? undefined : (toRaw(state) as Record<string, unknown>)

  if (raw === undefined || typeof key !== 'string' || !key.startsWith(STATE_KEY) || !(key in raw) || (target !== undefined && target !== raw)) return undefined

  return { name: `useState "${key.slice(STATE_KEY.length)}"`, state: raw }
}

/**
 * The name a value goes by: its binding in the setup of the component or of the nearest one above that holds it,
 * a field of what a composable handed back there, what a component above provided, or what Nuxt fetched.
 */
const bindingOf = (instance: Instance, isIt: (value: unknown) => boolean): Binding | undefined => {
  for (let at: Instance | null = instance; at !== null; at = at.parent) {
    const binding = among(Object.entries(at.devtoolsRawSetupState ?? {}), isIt)

    if (binding !== undefined) return binding
  }

  try {
    const provided = among(providedTo(instance), isIt)

    if (provided !== undefined) return { ...provided, name: `provided ${provided.name}` }

    return fetchedOf(instance, value => {
      try {
        return isIt(value)
      } catch {
        return false
      }
    })
  } catch {
    return undefined
  }
}

// The attributes and the slots a component was handed: Vue says a change of either as a change of nothing named
const handedTo = (instance: Instance, target: unknown, key: unknown): Step | undefined => {
  for (let at: Instance | null = instance; at !== null; at = at.parent) {
    const { attrs } = at
    const of = at === instance ? '' : ` of ${nameOf(at)}`

    if (key === '' && (attrs === target || toRaw(attrs) === target)) return { text: `attrs${of} changed`, read: () => attrs }
    if (key === '$slots' && at === target) return { text: `slots${of} changed` }
  }

  return undefined
}

// What a change set, and what was there before: Vue says both with the change
const changeOf = ({ type, newValue, oldValue }: DebuggerEvent): Pick<Step, 'value' | 'whole'> => {
  // Vue does not always say them: nothing is better said than "undefined (was undefined)"
  if (newValue === undefined && oldValue === undefined) return {}

  try {
    const cut = { is: false }
    const value = type === 'set' ? `${said(newValue, cut)} (was ${said(oldValue, cut)})` : type === 'add' ? said(newValue, cut) : undefined

    if (value === undefined) return {}

    return cut.is ? { value, whole: () => (type === 'set' ? { now: newValue, was: oldValue } : newValue) } : { value }
  } catch {
    return {}
  }
}

type Held = { value: string | null; whole: string | null }

// What a step held, shortly, and whole where the short value leaves some of it out
const heldBy = ({ text, value, whole: made, read }: Step): Held => {
  if (value === undefined && read === undefined) return { value: null, whole: null }
  if (SECRET_NAME.test(text)) return { value: '***', whole: null }

  try {
    if (value !== undefined) return { value, whole: made === undefined ? null : whole(made()) }

    const now = read?.()
    const cut = { is: false }
    const short = said(now, cut)

    return { value: short, whole: cut.is ? whole(now) : null }
  } catch {
    return { value: value ?? null, whole: null }
  }
}

/**
 * Listens for the renders of every component of the app, and calls `send` with the chains that led to them, each
 * once with its count and the values its steps last held, short and, where that leaves some out, whole. Does
 * nothing where Vue does not say what triggers a render: outside development.
 */
export const reportRenders = (app: App, send: (renders: ReportedRender[]) => void, { isOwn = file => !file.replace(/\\/g, '/').includes('/node_modules/'), everyMs = 2000 }: RendersOptions = {}) => {
  const counted = new Map<string, { component: string; steps: Step[]; count: number }>()
  const recent = new Map<number, { steps: Step[]; at: number }>()

  const owns = (instance: Instance): boolean => {
    const file = (instance.type as Named).__file

    return file !== undefined && isOwn(file)
  }

  // A prop changes because what holds the component rendered: that render's chain, then the prop
  const throughProp = (holder: Instance, key: unknown, rendered: Instance, change: Pick<Step, 'value' | 'whole'> = {}): Step[] => {
    const parent = holder.parent as Instance | null
    const before = parent === null ? undefined : recent.get(parent.uid)
    const led: Step[] = before !== undefined && Date.now() - before.at < SAME_ROUND_MS ? before.steps : parent === null ? [] : [{ text: nameOf(parent) }]
    const text = holder === rendered ? `prop ${String(key)}` : `prop ${String(key)} of ${nameOf(holder)}`

    return [...led, change.value !== undefined ? { text, ...change } : { text, read: () => (toRaw(holder.props) as Record<string, unknown>)[String(key)] }]
  }

  // A dependency Vue knows by its key alone: a prop of the component when it has one of that name, else a field of
  // the reactive object that has one
  const keyed = (instance: Instance, key: unknown): Step[] => {
    if (typeof key === 'string' && key in toRaw(instance.props)) return throughProp(instance, key, instance)
    // Vue keeps a component's attributes under no key at all
    if (key === '') return [{ text: 'attrs changed', read: () => instance.attrs }]

    const shared = sharedOf(instance, key)

    if (shared !== undefined) return [{ text: `${shared.name} changed`, read: () => shared.state[String(key)] }]

    const holder = bindingOf(instance, value => isReactive(value) && typeof key === 'string' && key in (toRaw(value) as object))

    // Without a name of its own, the key is that of the object's list of keys: something was added or taken away
    if (typeof key !== 'string') return [{ text: `${holder?.name ?? 'a reactive object'} changed` }]
    if (holder === undefined) return [{ text: `a reactive object.${key} changed` }]

    return [{ text: `${holder.name}.${key} changed`, read: () => (toRaw(holder.value) as Record<string, unknown>)[key] }]
  }

  // The stale dependency a subscriber hangs from, through the computed values between them
  const staleUnder = (instance: Instance, subscriber: Subscriber, seen: Set<unknown>): Step[] | undefined => {
    for (let link = subscriber.deps; link !== undefined; link = link.nextDep) {
      const dep = link.dep

      if (dep === undefined) continue

      if (dep.computed !== undefined) {
        const computed = dep.computed

        if (seen.has(computed)) continue

        seen.add(computed)

        const inner = staleUnder(instance, computed, seen)

        if (inner !== undefined) {
          return [...inner, { text: `${bindingOf(instance, value => value === computed)?.name ?? 'a computed value'} (computed)`, read: () => (computed as { value?: unknown }).value }]
        }
      } else if (dep.version !== link.version) {
        const ref = bindingOf(instance, value => isRef(value) && (value as { dep?: unknown }).dep === dep)

        if (ref !== undefined) return [{ text: `${ref.name} (ref) changed`, read: () => (ref.value as { value?: unknown }).value }]

        return dep.key !== undefined ? keyed(instance, dep.key) : [{ text: 'a ref changed' }]
      }
    }

    return undefined
  }

  const causeOf = (instance: Instance, event: DebuggerEvent): Step[] => {
    const { target, key, type } = event

    // Through a computed value, Vue names the render but not what changed: the stale dependency is looked for
    if (target === undefined) {
      try {
        return staleUnder(instance, event.effect as unknown as Subscriber, new Set()) ?? [{ text: 'a computed value changed' }]
      } catch {
        return [{ text: 'a computed value changed' }]
      }
    }

    const held = changeOf(event)

    // Its own props, or those of a component above whose slot it draws
    for (let at: Instance | null = instance; at !== null; at = at.parent) {
      if (toRaw(at.props) === target) return throughProp(at, key, instance, held)
    }

    if (isRef(target)) {
      const ref = bindingOf(instance, value => value === target)

      return [{ text: ref === undefined ? `a ref ${type}` : `${ref.name} (ref) ${type}`, ...held }]
    }

    const handed = handedTo(instance, target, key)

    if (handed !== undefined) return [handed]

    const shared = sharedOf(instance, key, target)

    if (shared !== undefined) return [{ text: `${shared.name} ${type}`, ...held }]

    const holder = bindingOf(instance, value => isReactive(value) && toRaw(value) === target)?.name ?? 'a reactive object'
    const field = typeof key === 'string' && key !== '' ? `.${key}` : ''

    return [{ text: `${holder}${field} ${type}`, ...held }]
  }

  const note = (instance: Instance, event: DebuggerEvent) => {
    const steps: Step[] = [...causeOf(instance, event), { text: nameOf(instance) }]

    recent.set(instance.uid, { steps, at: Date.now() })

    // A render inside a component of the app's own is that component's: its slots are drawn by what holds them
    let owner: Instance | null = instance

    while (owner !== null && !owns(owner)) owner = owner.parent

    const component = nameOf(owner ?? instance)
    const id = `${component}\n${steps.map(({ text }) => text).join('\n')}`
    const known = counted.get(id)

    // The values said are those of the last time
    if (known !== undefined) Object.assign(known, { steps, count: known.count + 1 })
    else if (counted.size < MAX_CHAINS) counted.set(id, { component, steps, count: 1 })
  }

  app.mixin({
    renderTriggered(event: DebuggerEvent) {
      try {
        note((this as unknown as { $: Instance }).$, event)
      } catch {
        // Watching the app never breaks it
      }
    },
  })

  const timer = setInterval(() => {
    const now = Date.now()

    for (const [uid, { at }] of recent) if (now - at > SAME_ROUND_MS) recent.delete(uid)

    if (counted.size === 0) return

    // Read here, outside any render, a value is looked at without becoming something the page depends on
    const renders = [...counted.values()].map(({ component, steps, count }) => {
      const held = steps.map(heldBy)

      return { component, chain: steps.map(({ text }) => text), values: held.map(({ value }) => value), whole: held.map(step => step.whole), count }
    })

    counted.clear()
    send(renders)
  }, everyMs)

  return () => clearInterval(timer)
}
