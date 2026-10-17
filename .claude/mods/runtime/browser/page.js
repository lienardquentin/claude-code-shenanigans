// What the runtime mod runs in a tab of the debug Chrome, each time it reads: a function, called with the apps it watches.
// It says which of them the page is, why the page's components rendered again since the last time, what the person
// did on it and what the page asked for since then, how it loaded, and the page's elements as they stand. The app
// holds none of this: the first call leaves two listeners in the page, under `window.__runtime__` (the renders,
// where Vue names them) and `window.__runtime_page__` (the rest, on any page), and every call empties what they
// counted. A page that is none of the apps is left alone.
//
// Why a component rendered is said as a chain: the state that changed, the computed values and the props that
// carried the change, down to the component, each with the value it held. Vue (3.5) tells a component what
// triggered its render only in development, and tells nobody else: the listener is hung on every component's
// render effect. Part of it reads Vue's own bookkeeping (which dependency of a computed value is stale), in fields
// Vue does not document. Every such read is guarded: where the fields are not there, the chain says less.
//
// What a field of a form holds is never said, nor a value that goes by a secret's name.
(watched => {
  const VERSION = 5
  const KEY = '__runtime__'
  const PAGE_VERSION = 2
  const PAGE_KEY = '__runtime_page__'
  // Up to where the page's console was last read: kept in the page, so that a page loaded again is read from its start
  const HEARD_KEY = '__runtime_heard__'

  const MAX_ACTIONS = 30
  const MAX_REQUESTS = 60
  const MAX_ISSUES = 30
  // What follows something done on the page is counted as its doing for this long
  const ACTION_MS = 1500
  // What the tools that serve the page in development ask for is none of the app's own asking, nor the icons
  // Nuxt fetches for the components that draw them
  const TOOLING_PATH = /^\/(_nuxt|__nuxt\w*|@vite|@fs|@id|node_modules|__vite\w*|api\/_nuxt_icon)\//
  // A submit or a change that comes this soon after a click is that click's doing, not a thing done of its own
  const SAME_GESTURE_MS = 100

  const MAX_CHAINS = 100
  const MAX_VALUE = 80
  const MAX_ITEMS = 4
  const MAX_WHOLE = 1500
  const MAX_FILES = 12
  // A parent's chain is the start of its child's for as long as one round of rendering takes
  const SAME_ROUND_MS = 250
  // A value that goes by such a name is never said
  const SECRET_NAME = /secret|token|passw|credential|api[_-]?key|authorization|cookie/i

  const MAX_ELEMENTS = 300
  const MAX_DEPTH = 40
  const MAX_CLASSES = 2
  const MAX_TEXT = 60
  // What stands on a page without being of it, and what a reader of the page never sees
  const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'IFRAME'])
  const TOOLING = /devtools|vite-error-overlay/i
  // What says what an element is to a reader of the page, or how it stands
  const TOLD = ['role', 'aria-label', 'aria-pressed', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-hidden', 'href', 'type', 'name', 'placeholder', 'for', 'alt']
  const STANDING = ['disabled', 'hidden', 'checked', 'open']
  // What holds a value the person gave: a field, or what a library draws in a field's place. Its words are that value
  const HOLDS = 'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="slider"]'
  // What a click is meant for; a click anywhere else counts only where the page shows a hand
  const PRESSED = 'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="combobox"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]'

  const tidy = path => String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const isOwn = file => !tidy(file).includes('/node_modules/')

  // Vue's own tests of a value, read off the marks it leaves: the page's Vue cannot be imported from here
  const toRaw = value => {
    const raw = value && value.__v_raw

    return raw ? toRaw(raw) : value
  }

  const isRef = value => typeof value === 'object' && value !== null && value.__v_isRef === true
  const isReactive = value => typeof value === 'object' && value !== null && value.__v_isReactive === true

  // ── The apps of the page ──────────────────────────────────────────────────────────────────────────────────

  // Vue leaves the app on the element it is mounted in, which is marked, or near the top of the body where what
  // the server drew was taken over (the mark is then gone)
  const appsOf = () => [...new Set([...document.querySelectorAll('[data-v-app], body > *, body > * > *')].flatMap(element => (element.__vue_app__ ? [element.__vue_app__] : [])))]

  // Every component that stands on the page, from each app's root down
  const instancesOf = () => {
    const found = []
    const seen = new Set()
    const left = appsOf().map(app => app._instance?.subTree)

    for (const app of appsOf()) if (app._instance) found.push(app._instance)

    while (left.length > 0 && seen.size < 20000) {
      const vnode = left.pop()

      if (typeof vnode !== 'object' || vnode === null || seen.has(vnode)) continue

      seen.add(vnode)

      if (vnode.component) {
        found.push(vnode.component)
        left.push(vnode.component.subTree)
      }

      if (Array.isArray(vnode.children)) for (const child of vnode.children) left.push(child)
      if (vnode.suspense) left.push(vnode.suspense.activeBranch)
    }

    return found
  }

  const nameOf = instance => {
    const { __name, name, __file } = instance.type ?? {}

    return __name ?? name ?? /([^/\\]+)\.\w+$/.exec(__file ?? '')?.[1] ?? 'Anonymous'
  }

  const owns = instance => {
    const file = instance.type?.__file

    return file !== undefined && isOwn(file)
  }

  // Whether a component is one the app's own source writes: one of its own, or a library's that stands in the
  // template of one of its own (a button in a card's slot too: Vue keeps on a component who drew it). The
  // components a library's is made of are its insides
  const isWritten = instance => owns(instance) || (instance.vnode?.ctx ? owns(instance.vnode.ctx) : false)

  // The written component a library's inside is part of; none above the app's own source
  const holderOf = instance => {
    for (let at = instance.parent; at; at = at.parent) if (isWritten(at)) return at

    return undefined
  }

  // ── Which of the watched apps the page is ─────────────────────────────────────────────────────────────────

  const filesOf = instances => [...new Set(instances.flatMap(instance => (owns(instance) ? [tidy(instance.type.__file)] : [])))]

  // The app one of whose source folders holds the page's components; else the one that listens where the page is
  const labelOf = files => {
    for (const { label, roots } of watched) {
      if ((roots ?? []).some(root => files.some(file => file.startsWith(`${tidy(root)}/`)))) return label
    }

    return watched.find(({ port }) => port > 0 && String(port) === location.port)?.label
  }

  // ── A value, said ─────────────────────────────────────────────────────────────────────────────────────────

  const clip = text => (text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text)

  // Whether what an object is made from makes it a plain one: Vue makes a component's attributes from an object of
  // its own, which is one all the same
  const isPlain = kind => kind === null || kind === Object.prototype || kind.constructor === Object

  // A value in few words, its fields and items to two levels (a list of small objects reads): never the whole of a
  // large object
  const brief = (value, depth, cut) => {
    if (typeof value === 'string') {
      if (value.length > 40) cut.is = true

      return JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value)
    }

    if (typeof value === 'function') return 'a function'
    if (typeof value !== 'object' || value === null) return String(value)

    const raw = toRaw(value)

    // What a ref holds is read where Vue keeps it: reading it the usual way here could make a render depend on it
    if (isRef(raw)) return brief(raw._value, depth, cut)
    if (raw instanceof Date) return raw.toISOString()

    if (Array.isArray(raw)) {
      if (depth > 1 || raw.length > MAX_ITEMS) cut.is = true
      if (depth > 1) return `[${raw.length}]`

      return `[${raw.slice(0, MAX_ITEMS).map(item => brief(item, depth + 1, cut)).join(', ')}${raw.length > MAX_ITEMS ? `, … ${raw.length} in all` : ''}]`
    }

    const kind = Object.getPrototypeOf(raw)

    // What is not a plain object is said by its kind: an element, a map, a component
    if (!isPlain(kind)) return kind?.constructor?.name ?? 'an object'

    const fields = Object.entries(raw)

    if (depth > 1 || fields.length > MAX_ITEMS) cut.is = true
    if (depth > 1) return '{…}'

    return `{${fields.slice(0, MAX_ITEMS).map(([key, field]) => `${key}: ${SECRET_NAME.test(key) ? '***' : brief(field, depth + 1, cut)}`).join(', ')}${fields.length > MAX_ITEMS ? ', …' : ''}}`
  }

  // A value as a chain says it: cut short. `cut` is told when some of it is left out
  const said = (value, cut = { is: false }) => {
    const text = brief(value, 0, cut)

    if (text.length > MAX_VALUE) cut.is = true

    return clip(text)
  }

  // A value as data JSON can write, to a depth and a number of items and fields
  const plain = (value, depth, most) => {
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 299)}…` : value
    if (typeof value === 'function') return 'a function'
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    if (typeof value !== 'object' || value === null) return value ?? null

    const raw = toRaw(value)

    if (isRef(raw)) return plain(raw._value, depth, most)
    if (raw instanceof Date) return raw.toISOString()

    if (Array.isArray(raw)) {
      if (depth <= 0) return `[${raw.length}]`

      return [...raw.slice(0, most).map(item => plain(item, depth - 1, most)), ...(raw.length > most ? [`… ${raw.length} in all`] : [])]
    }

    if (!isPlain(Object.getPrototypeOf(raw))) return Object.getPrototypeOf(raw)?.constructor?.name ?? 'an object'
    if (depth <= 0) return '{…}'

    const fields = Object.entries(raw)
    const kept = fields.slice(0, most).map(([key, field]) => [key, SECRET_NAME.test(key) ? '***' : plain(field, depth - 1, most)])

    return Object.fromEntries(fields.length > most ? [...kept, ['…', `${fields.length} fields in all`]] : kept)
  }

  // A value whole, as JSON text: as deep and as long as fits, less of it when it does not; null when nothing fits
  const whole = value => {
    for (const [depth, most] of [[5, 40], [3, 12], [2, 5]]) {
      const text = JSON.stringify(plain(value, depth, most))

      if (text !== undefined && text.length <= MAX_WHOLE) return text
    }

    return null
  }

  // ── The name a value goes by ──────────────────────────────────────────────────────────────────────────────

  // A plain object of the app's own, which may hold state under its fields: what a composable handed back whole
  const isHolder = value => typeof value === 'object' && value !== null && !isRef(value) && !isReactive(value) && Object.getPrototypeOf(value) === Object.prototype

  // The one of the named values that is looked for: by its own name, else as a field of one that holds state
  const among = (named, isIt) => {
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
  const providedTo = instance => {
    const named = []

    for (let held = instance.provides ?? null; held !== null && held !== Object.prototype; held = Object.getPrototypeOf(held)) {
      for (const key of Reflect.ownKeys(held)) named.push([typeof key === 'symbol' ? (key.description ?? 'a symbol') : key, held[key]])
    }

    return named
  }

  // What Nuxt keeps for the app, as much of it as is read here: what was fetched, by its key, and the shared state
  const nuxtOf = instance => instance.appContext?.config?.globalProperties?.$nuxt

  const FETCHED = ['data', 'status', 'error', 'pending']
  // The key Nuxt gives a `useFetch` that names none, and the one it keeps a `useState` under
  const FETCH_KEY = '$f'
  const STATE_KEY = '$s'

  // The ref of something fetched, which the component holds only through a computed value: `useFetch data`
  const fetchedOf = (instance, isIt) => {
    for (const [key, entry] of Object.entries(nuxtOf(instance)?._asyncData ?? {})) {
      for (const field of FETCHED) {
        const value = entry?.[field]

        if (isIt(value)) return { name: `${key.startsWith(FETCH_KEY) ? 'useFetch' : `useAsyncData "${key}"`} ${field}`, value }
      }
    }

    return undefined
  }

  // The shared state a key is one of, when it is: `useState "cart"`
  const sharedOf = (instance, key, target) => {
    const state = nuxtOf(instance)?.payload?.state
    const raw = state === undefined ? undefined : toRaw(state)

    if (raw === undefined || typeof key !== 'string' || !key.startsWith(STATE_KEY) || !(key in raw) || (target !== undefined && target !== raw)) return undefined

    return { name: `useState "${key.slice(STATE_KEY.length)}"`, state: raw }
  }

  // The name a value goes by: its binding in the setup of the component or of the nearest one above that holds it,
  // a field of what a composable handed back there, what a component above provided, or what Nuxt fetched
  const bindingOf = (instance, isIt) => {
    for (let at = instance; at; at = at.parent) {
      const binding = among(Object.entries(at.devtoolsRawSetupState ?? {}), isIt)

      // Named in a component of the app's own, the state is the app's; in a library's, it is that library's business
      if (binding !== undefined) return { ...binding, own: owns(at) }
    }

    try {
      const provided = among(providedTo(instance), isIt)

      if (provided !== undefined) return { ...provided, name: `provided ${provided.name}`, own: false }

      const fetched = fetchedOf(instance, value => {
        try {
          return isIt(value)
        } catch {
          return false
        }
      })

      // What Nuxt fetched was asked for by the app
      return fetched === undefined ? undefined : { ...fetched, own: true }
    } catch {
      return undefined
    }
  }

  // The attributes and the slots a component was handed: Vue says a change of either as a change of nothing named
  const handedTo = (instance, target, key) => {
    for (let at = instance; at; at = at.parent) {
      const { attrs } = at
      const of = at === instance ? '' : ` of ${nameOf(at)}`

      if (key === '' && (attrs === target || toRaw(attrs) === target)) return { text: `attrs${of} changed`, read: () => attrs }
      if (key === '$slots' && at === target) return { text: `slots${of} changed` }
    }

    return undefined
  }

  // What a change set, and what was there before: Vue says both with the change
  const changeOf = ({ type, newValue, oldValue }) => {
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

  // What a step held, shortly, and whole where the short value leaves some of it out
  const heldBy = ({ text, value, whole: made, read }) => {
    if (value === undefined && read === undefined) return { value: null, whole: null }
    if (SECRET_NAME.test(text)) return { value: '***', whole: null }

    try {
      if (value !== undefined) return { value, whole: made === undefined ? null : whole(made()) }

      const now = read()
      const cut = { is: false }
      const short = said(now, cut)

      return { value: short, whole: cut.is ? whole(now) : null }
    } catch {
      return { value: value ?? null, whole: null }
    }
  }

  // ── The listener the first call leaves in the page ────────────────────────────────────────────────────────

  const listen = () => {
    const counted = new Map()
    const recent = new Map()
    const hung = new WeakSet()
    const state = { version: VERSION, isLive: true }

    // A prop changes because what holds the component rendered: that render's chain, then the prop
    const throughProp = (holder, key, rendered, change = {}) => {
      const parent = holder.parent
      const before = parent ? recent.get(parent.uid) : undefined
      // Where that render was not seen, it is said by the component the app wrote there
      // A prop handed by a component the app wrote is the app's doing; one a library hands its own parts is not
      const led = before !== undefined && Date.now() - before.at < SAME_ROUND_MS ? before.steps : parent ? [{ text: nameOf(isWritten(parent) ? parent : (holderOf(parent) ?? parent)), own: isWritten(parent) }] : []
      // The chain ends on the component the app wrote: a prop of that one is its own
      const ends = isWritten(rendered) ? rendered : (holderOf(rendered) ?? rendered)
      const text = holder === ends || nameOf(holder) === nameOf(ends) ? `prop ${String(key)}` : `prop ${String(key)} of ${nameOf(holder)}`

      return [...led, change.value !== undefined ? { text, ...change } : { text, read: () => toRaw(holder.props)[String(key)] }]
    }

    // A dependency Vue knows by its key alone: a prop of the component when it has one of that name, else a field
    // of the reactive object that has one
    const keyed = (instance, key) => {
      if (typeof key === 'string' && key in toRaw(instance.props)) return throughProp(instance, key, instance)
      // Vue keeps a component's attributes under no key at all
      if (key === '') return [{ text: 'attrs changed', read: () => instance.attrs }]

      const shared = sharedOf(instance, key)

      if (shared !== undefined) return [{ text: `${shared.name} changed`, own: true, read: () => shared.state[String(key)] }]

      const holder = bindingOf(instance, value => isReactive(value) && typeof key === 'string' && key in toRaw(value))

      // Without a name of its own, the key is that of the object's list of keys: something was added or taken away
      if (typeof key !== 'string') return [{ text: `${holder?.name ?? 'a reactive object'} changed`, own: holder?.own === true }]
      if (holder === undefined) return [{ text: `a reactive object.${key} changed` }]

      return [{ text: `${holder.name}.${key} changed`, own: holder.own, read: () => toRaw(holder.value)[key] }]
    }

    // The stale dependency a subscriber hangs from, through the computed values between them
    const staleUnder = (instance, subscriber, seen) => {
      for (let link = subscriber.deps; link !== undefined && link !== null; link = link.nextDep) {
        const dep = link.dep

        if (dep === undefined) continue

        if (dep.computed !== undefined) {
          const computed = dep.computed

          if (seen.has(computed)) continue

          seen.add(computed)

          const inner = staleUnder(instance, computed, seen)

          if (inner !== undefined) {
            const named = bindingOf(instance, value => value === computed)

            return [...inner, { text: `${named?.name ?? 'a computed value'} (computed)`, own: named?.own === true, read: () => computed.value }]
          }
        } else if (dep.version !== link.version) {
          const ref = bindingOf(instance, value => isRef(value) && value.dep === dep)

          if (ref !== undefined) return [{ text: `${ref.name} (ref) changed`, own: ref.own, read: () => ref.value.value }]

          return dep.key !== undefined ? keyed(instance, dep.key) : [{ text: 'a ref changed' }]
        }
      }

      return undefined
    }

    const causeOf = (instance, event) => {
      const { target, key, type } = event

      // Through a computed value, Vue names the render but not what changed: the stale dependency is looked for
      if (target === undefined) {
        try {
          return staleUnder(instance, event.effect, new Set()) ?? [{ text: 'a computed value changed' }]
        } catch {
          return [{ text: 'a computed value changed' }]
        }
      }

      const held = changeOf(event)

      // Its own props, or those of a component above whose slot it draws
      for (let at = instance; at; at = at.parent) {
        if (toRaw(at.props) === target) return throughProp(at, key, instance, held)
      }

      if (isRef(target)) {
        const ref = bindingOf(instance, value => value === target)

        return [{ text: ref === undefined ? `a ref ${type}` : `${ref.name} (ref) ${type}`, own: ref?.own === true, ...held }]
      }

      const handed = handedTo(instance, target, key)

      if (handed !== undefined) return [handed]

      const shared = sharedOf(instance, key, target)

      if (shared !== undefined) return [{ text: `${shared.name} ${type}`, own: true, ...held }]

      const holder = bindingOf(instance, value => isReactive(value) && toRaw(value) === target)
      const field = typeof key === 'string' && key !== '' ? `.${key}` : ''

      return [{ text: `${holder?.name ?? 'a reactive object'}${field} ${type}`, own: holder?.own === true, ...held }]
    }

    const idOf = (component, steps) => `${component}\n${steps.map(({ text }) => text).join('\n')}`

    const note = (instance, event) => {
      // A render inside a component of the app's own is that component's: its slots are drawn by what holds them
      let owner = instance

      while (owner && !owns(owner)) owner = owner.parent

      const component = nameOf(owner ?? instance)
      const file = (owner ?? instance).type?.__file ?? ''
      // Rendered just after something was done on the page: counted as that thing's doing. What a library's
      // component is made of is not counted: a toast that ticks would bury what the click did
      const acts = () => {
        const acted = window[PAGE_KEY]?.current

        if (acted && Date.now() - acted.at < ACTION_MS) acted.renders[component] = (acted.renders[component] ?? 0) + 1
      }

      // Counted on a chain as what rendered inside its component
      const within = steps => {
        const id = idOf(component, steps)
        const known = counted.get(id)

        if (known !== undefined) known.inside += 1
        else if (counted.size < MAX_CHAINS) counted.set(id, { component, file, steps, count: 0, inside: 1 })
      }

      // What a library's component is made of is not told apart: its render is said of the component the app wrote
      const holder = isWritten(instance) ? undefined : holderOf(instance)
      const led = holder === undefined ? undefined : recent.get(holder.uid)

      // The written component rendered in this round, and this is the rest of it: counted on that chain, as inside
      if (led !== undefined && Date.now() - led.at < SAME_ROUND_MS) {
        recent.set(instance.uid, { steps: led.steps, at: led.at })
        within(led.steps)

        return
      }

      // Else it rendered for a reason of its own (a slot it draws read the state): the chain ends on the written one
      const cause = causeOf(instance, event)
      const steps = [...cause, { text: nameOf(holder ?? instance) }]

      recent.set(instance.uid, { steps, at: Date.now() })

      // A library's part that rendered for a reason no state of the app's is behind (a timer of its own, what it
      // hands its own parts) is the library's business: counted inside the written component, on no chain of its own
      if (holder !== undefined && !cause.some(step => step.own === true)) {
        within([{ text: nameOf(holder) }])

        return
      }

      acts()

      const id = idOf(component, steps)
      const known = counted.get(id)

      // The values said are those of the last time
      if (known !== undefined) Object.assign(known, { steps, count: known.count + 1 })
      else if (counted.size < MAX_CHAINS) counted.set(id, { component, file, steps, count: 1, inside: 0 })
    }

    // Vue calls a render effect's `onTrigger` with what triggered it, in development: the listener goes there,
    // before whatever the app itself hung on it
    const hang = instance => {
      const effect = instance.effect

      if (typeof effect !== 'object' || effect === null || hung.has(instance)) return

      hung.add(instance)

      const before = effect.onTrigger

      effect.onTrigger = event => {
        if (state.isLive) {
          try {
            note(instance, event)
          } catch {
            // Watching the app never breaks it
          }
        }

        return typeof before === 'function' ? before(event) : undefined
      }
    }

    const sweep = () => {
      try {
        for (const instance of instancesOf()) hang(instance)
      } catch {
        // A tree that cannot be walked is walked again at the next change
      }
    }

    // A component that comes to the page later is found when the page changes
    let sweeping
    const watcher = new MutationObserver(() => {
      sweeping ??= setTimeout(() => {
        sweeping = undefined
        if (state.isLive) sweep()
      }, 50)
    })

    watcher.observe(document.documentElement, { childList: true, subtree: true })
    sweep()

    return Object.assign(state, {
      sweep,
      // The chains counted since the last call, each with the values its steps hold now. Read here, outside any
      // render, a value is looked at without becoming something the page depends on
      take: () => {
        const now = Date.now()

        for (const [uid, { at }] of recent) if (now - at > SAME_ROUND_MS) recent.delete(uid)

        const renders = [...counted.values()].map(({ component, file, steps, count, inside }) => {
          const held = steps.map(heldBy)

          return { component, file, chain: steps.map(({ text }) => text), values: held.map(({ value }) => value), whole: held.map(step => step.whole), count, inside }
        })

        counted.clear()

        return renders
      },
      stop: () => {
        state.isLive = false
        watcher.disconnect()
      },
    })
  }

  // ── The page's elements ───────────────────────────────────────────────────────────────────────────────────

  const short = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

  const tagOf = element => {
    const classes = [...element.classList]
    const named = classes.slice(0, MAX_CLASSES).map(name => `.${short(name, 24)}`).join('')

    return `${element.tagName.toLowerCase()}${element.id === '' ? '' : `#${short(element.id, 24)}`}${named}${classes.length > MAX_CLASSES ? '…' : ''}`
  }

  const attributesOf = element =>
    [
      ...TOLD.flatMap(name => {
        const value = element.getAttribute(name)

        return value === null || value === '' ? [] : [`${name}=${JSON.stringify(short(value, 40))}`]
      }),
      ...STANDING.filter(name => element.hasAttribute(name)),
    ].join(' ')

  // The text an element holds itself, not what the elements in it hold; none of what stands in a field
  const textOf = element =>
    element.closest(HOLDS) !== null
      ? ''
      : short(
          [...element.childNodes]
            .filter(node => node.nodeType === 3)
            .map(node => node.textContent ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          MAX_TEXT,
        )

  // The words an element shows, those of the elements in it too, a space between two of them: never a field's
  const wordsOf = element => {
    const words = []

    const walk = node => {
      if (node.nodeType === 3) words.push(node.textContent ?? '')
      else if (node.nodeType === 1 && !SKIPPED.has(node.tagName) && !node.matches(HOLDS)) for (const child of node.childNodes) walk(child)
    }

    if (element) walk(element)

    return words.join(' ').replace(/\s+/g, ' ').trim()
  }

  // The component of the app's own an element is the outermost one of: the one whose template it is drawn by
  const componentOf = element => {
    let name = ''

    for (let at = element.__vueParentComponent ?? null; at !== null && at.subTree?.el === element; at = at.parent) {
      if (owns(at)) name = nameOf(at)
    }

    return name
  }

  // The component of the app's own an element is drawn in, however deep in it
  const drawnBy = element => {
    for (let at = element; at; at = at.parentElement) {
      for (let component = at.__vueParentComponent ?? null; component; component = component.parent) if (owns(component)) return nameOf(component)
    }

    return ''
  }

  const isTooling = element => {
    for (let at = element; at; at = at.parentElement) if (TOOLING.test(at.tagName) || TOOLING.test(at.id)) return true

    return false
  }

  // ── What a reader who does not see the page cannot use ────────────────────────────────────────────────────

  const issuesOf = () => {
    const issues = []
    const add = (kind, element) => {
      if (issues.length < MAX_ISSUES) issues.push([kind, tagOf(element), drawnBy(element)])
    }

    const isRead = element => element.closest('[hidden], [aria-hidden="true"]') === null && !isTooling(element)
    const says = (element, name) => (element.getAttribute(name) ?? '').trim() !== ''
    const isNamed = element =>
      says(element, 'aria-label') || says(element, 'aria-labelledby') || says(element, 'title') || (element.textContent ?? '').trim() !== '' || element.querySelector('img[alt]:not([alt=""]), svg[aria-label], svg title') !== null

    for (const element of document.querySelectorAll('button, [role="button"], a[href]')) {
      if (isRead(element) && !isNamed(element)) add(element.tagName === 'A' ? 'a link with no name' : 'a button with no name', element)
    }

    for (const element of document.querySelectorAll('img:not([alt])')) if (isRead(element)) add('an image with no alt', element)

    for (const element of document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea')) {
      if (!isRead(element)) continue

      const isLabelled =
        says(element, 'aria-label') || says(element, 'aria-labelledby') || says(element, 'title') || element.closest('label') !== null || (element.id !== '' && document.querySelector(`label[for="${CSS.escape(element.id)}"]`) !== null)

      if (!isLabelled) add('a field with no label', element)
    }

    const ids = new Map()

    // A drawing's own ids are its own business
    for (const element of document.querySelectorAll('[id]')) {
      if (element.id === '' || element.closest('svg') !== null || isTooling(element)) continue
      if (ids.get(element.id) === 1) add(`the id ${short(element.id, 24)} used more than once`, element)

      ids.set(element.id, (ids.get(element.id) ?? 0) + 1)
    }

    if (!says(document.documentElement, 'lang')) issues.push(['the page names no language', 'html', ''])
    if (document.querySelector('h1') === null) issues.push(['the page has no h1', 'body', ''])

    return issues
  }

  // ── What is done on the page, what it asks for and how it loaded ──────────────────────────────────────────

  // An address as it may be said: its path, and the names of what it was asked with, never their values
  const addressOf = address => {
    try {
      const { origin, pathname, searchParams } = new URL(address, location.href)
      const asked = [...new Set(searchParams.keys())].slice(0, 6).join('&')

      return `${origin === location.origin ? '' : origin}${pathname}${asked === '' ? '' : `?${asked}`}`
    } catch {
      return ''
    }
  }

  // What something was done to, never what a field holds: `button "Light Halifirien"`, `input email`. A field is
  // said by its label, a form by its name or its first label or heading, anything else by the words it shows
  const whatOf = element => {
    const tag = element.tagName.toLowerCase()
    const isField = tag === 'input' || tag === 'select' || tag === 'textarea'
    const said = name => (element.getAttribute(name) ?? '').trim()
    const labelled = element.id === '' ? '' : wordsOf(document.querySelector(`label[for="${CSS.escape(element.id)}"]`))
    const own = isField ? said('name') || said('placeholder') : tag === 'form' ? said('name') || wordsOf(element.querySelector('legend, label, h1, h2, h3, h4, h5, h6')) : wordsOf(element)
    const name = short(said('aria-label') || labelled || own, 40)

    return `${tag}${tag === 'input' && said('type') ? `[${said('type')}]` : ''}${name === '' ? '' : ` ${JSON.stringify(name)}`}`
  }

  const watchPage = () => {
    const actions = []
    const requests = []
    const vitals = { lcp: 0, cls: 0, inp: 0, longTasks: 0, longMs: 0 }
    const observers = []
    const state = { version: PAGE_VERSION, isLive: true, current: undefined }
    const epoch = at => Math.round(performance.timeOrigin + at)

    // The browser keeps what it measured before it was asked: `buffered` hands that over too
    const observe = (type, more, heard) => {
      try {
        const observer = new PerformanceObserver(list => {
          if (!state.isLive) return

          for (const entry of list.getEntries()) {
            try {
              heard(entry)
            } catch {
              // Watching the page never breaks it
            }
          }
        })

        observer.observe({ type, buffered: true, ...more })
        observers.push(observer)
      } catch {
        // A browser that does not measure it says nothing of it
      }
    }

    observe('resource', {}, entry => {
      if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') return

      const url = addressOf(entry.name)

      if (url === '' || TOOLING_PATH.test(url)) return
      if (requests.length >= MAX_REQUESTS) requests.shift()

      // The browser tells a page the status of another site's answer only where that site allows it: -1, not told
      const status = entry.responseStatus || (new URL(entry.name, location.href).origin === location.origin ? 0 : -1)

      requests.push({ url, status, ms: Math.round(entry.duration), at: epoch(entry.startTime), isTaken: false })
    })
    observe('largest-contentful-paint', {}, entry => {
      vitals.lcp = Math.round(entry.startTime)
    })
    observe('layout-shift', {}, entry => {
      if (!entry.hadRecentInput) vitals.cls += entry.value
    })
    observe('event', { durationThreshold: 40 }, entry => {
      if (entry.interactionId && entry.duration > vitals.inp) vitals.inp = Math.round(entry.duration)
    })
    observe('longtask', {}, entry => {
      vitals.longTasks += 1
      vitals.longMs += Math.round(entry.duration)
    })

    const act = (kind, what, component) => {
      if (!state.isLive) return
      if (actions.length >= MAX_ACTIONS) actions.shift()

      state.current = { at: Date.now(), kind, what, component, renders: {}, isTaken: false }
      actions.push(state.current)
    }

    const on = kind => event => {
      try {
        const target = event.target instanceof Element ? event.target : undefined
        const pressed = kind === 'click' ? target?.closest(PRESSED) : undefined
        const element = pressed ?? target

        if (element === undefined || isTooling(element)) return
        // A click on what is not made to be clicked, and does not show a hand, is a press that slid off its mark
        if (kind === 'click' && !pressed && getComputedStyle(element).cursor !== 'pointer') return

        const before = state.current
        const isSameGesture = before !== undefined && before.kind === 'click' && !before.isTaken && Date.now() - before.at < SAME_GESTURE_MS

        // The button that sends a form is clicked, then the form is sent: one thing done, said as the sending
        if (kind === 'submit' && isSameGesture) {
          Object.assign(before, { kind, what: `${whatOf(element)} with ${before.what}` })

          return
        }

        // A box that is ticked is clicked, then changed: the click says it
        if (kind === 'change' && isSameGesture) return

        act(kind, whatOf(element), drawnBy(element))
      } catch {
        // Watching the page never breaks it
      }
    }

    const heard = [['click', on('click')], ['submit', on('submit')], ['change', on('change')]]

    for (const [kind, listener] of heard) document.addEventListener(kind, listener, true)

    // A move to another address that follows something done is that thing's doing; else it is a thing done itself
    let address = location.pathname
    const moved = () => {
      if (location.pathname === address) return

      address = location.pathname

      const acted = state.current

      if (acted && Date.now() - acted.at < ACTION_MS) acted.what = `${acted.what} → ${address}`
      else act('navigate', address, '')
    }

    window.addEventListener('popstate', moved)
    window.navigation?.addEventListener?.('navigatesuccess', moved)

    const loadOf = () => {
      const [entry] = performance.getEntriesByType('navigation')

      return { ttfb: Math.round(entry?.responseStart ?? 0), load: Math.round(entry?.loadEventEnd ?? 0) }
    }

    return Object.assign(state, {
      // What was asked for since the last call, what was done long enough ago for what followed to be over, and how
      // the page stands
      take: () => {
        const now = Date.now()
        const asked = requests.filter(request => !request.isTaken)
        const done = actions.filter(action => !action.isTaken && now - action.at >= ACTION_MS)

        for (const taken of [...asked, ...done]) taken.isTaken = true

        return {
          requests: asked.map(({ url, status, ms, at }) => ({ url, status, ms, at })),
          actions: done.map(({ at, kind, what, component, renders }) => {
            // What follows the next thing done is that one's doing
            const next = actions.find(action => action.at > at)
            const until = Math.min(at + ACTION_MS, next === undefined ? Infinity : next.at - 20)

            return {
              at,
              kind,
              what,
              component,
              renders,
              requests: requests.filter(request => request.at >= at - 20 && request.at < until).map(({ url, status, ms }) => `${status === 0 ? 'no answer' : status < 0 ? 'answered' : status} ${url} ${ms}ms`),
            }
          }),
          vitals: { loadedAt: Math.round(performance.timeOrigin), ...loadOf(), ...vitals, cls: Math.round(vitals.cls * 1000) / 1000 },
        }
      },
      stop: () => {
        state.isLive = false

        for (const observer of observers) observer.disconnect()
        for (const [kind, listener] of heard) document.removeEventListener(kind, listener, true)

        window.removeEventListener('popstate', moved)
        window.navigation?.removeEventListener?.('navigatesuccess', moved)
      },
    })
  }

  // Each element as how deep it is nested, what it is, what it is to a reader, its own text, and its component
  const domOf = () => {
    const elements = []
    let left = 0

    const walk = (element, depth) => {
      if (SKIPPED.has(element.tagName) || TOOLING.test(element.tagName) || TOOLING.test(element.id)) return

      if (elements.length >= MAX_ELEMENTS || depth > MAX_DEPTH) {
        left += 1

        return
      }

      let component = ''

      try {
        component = componentOf(element)
      } catch {
        // An element whose component cannot be told is still an element
      }

      elements.push([depth, tagOf(element), attributesOf(element), textOf(element), component])

      // A drawing is one element to a reader of the page
      if (element.tagName.toLowerCase() === 'svg') return

      for (const child of element.children) walk(child, depth + 1)
    }

    if (document.body) walk(document.body, 0)

    return { url: `${location.pathname}${location.search}`, title: document.title, elements, left }
  }

  // ── What a call answers ───────────────────────────────────────────────────────────────────────────────────

  const instances = instancesOf()
  const files = filesOf(instances)
  const label = labelOf(files)

  // None of the watched apps: nothing is read of the page, and nothing left in it
  if (label === undefined) return JSON.stringify(null)

  // Vue keeps a component's setup bindings for its tools in development alone, where it also names what triggers
  const vue = appsOf()[0]?.version ?? ''
  const isDev = instances.some(instance => 'devtoolsRawSetupState' in instance)

  let held = window[KEY]

  if (held !== undefined && held.version !== VERSION) {
    held.stop?.()
    held = undefined
  }

  if (held === undefined && isDev) held = window[KEY] = listen()

  held?.sweep()

  let page = window[PAGE_KEY]

  if (page !== undefined && page.version !== PAGE_VERSION) {
    page.stop?.()
    page = undefined
  }

  if (page === undefined) page = window[PAGE_KEY] = watchPage()

  let issues = []

  try {
    issues = issuesOf()
  } catch {
    // A page that cannot be judged is still shown
  }

  return JSON.stringify({
    label,
    address: location.href,
    isVisible: document.visibilityState === 'visible',
    vue,
    isDev,
    files: files.slice(0, MAX_FILES),
    renders: held?.take() ?? [],
    ...page.take(),
    // Up to where the console was read the last time, in milliseconds: what it holds past that is asked for next
    heard: typeof window[HEARD_KEY] === 'number' ? window[HEARD_KEY] : 0,
    dom: { ...domOf(), issues, files: Object.fromEntries(instances.flatMap(instance => (owns(instance) ? [[nameOf(instance), String(instance.type.__file).replace(/\\/g, '/')]] : [])).slice(0, 60)) },
  })
})
