// The page as it stands: its elements, nested as the document nests them, each with what tells it apart (its id,
// its first classes, what it is to a reader of the page) and the text it holds itself. Nothing outside the
// browser can see the page; this hands it over when it has changed, a few seconds apart at most.
//
// What a field holds is never said: only that it is there. Scripts, styles and the insides of a drawing are left
// out, and so are the tools a framework adds to the page in development.

/** One element: how deep it is nested, what it is, what it is to a reader, its own text, and its component. */
export type ReportedElement = [depth: number, tag: string, attributes: string, text: string, component: string]

/** The page's elements from the top of its body down, each after the one that holds it. */
export type ReportedDom = {
  url: string
  title: string
  elements: ReportedElement[]
  /** How many elements were left out, past the most a report holds. */
  left: number
}

export type DomOptions = {
  /** Whether a component file is the app's own; by default, any that is not an installed package's. */
  isOwn?: (file: string) => boolean
  /** How often the page is looked at again, in milliseconds. */
  everyMs?: number
}

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

// Vue's own bookkeeping on an element in development, as much of it as is read here
type Instance = { type: { __name?: string; name?: string; __file?: string }; subTree?: { el?: unknown }; parent: Instance | null }

const short = (text: string, most: number): string => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

const tagOf = (element: Element): string => {
  const classes = [...element.classList]
  const named = classes.slice(0, MAX_CLASSES).map(name => `.${short(name, 24)}`).join('')

  return `${element.tagName.toLowerCase()}${element.id === '' ? '' : `#${short(element.id, 24)}`}${named}${classes.length > MAX_CLASSES ? '…' : ''}`
}

const attributesOf = (element: Element): string =>
  [
    ...TOLD.flatMap(name => {
      const value = element.getAttribute(name)

      return value === null || value === '' ? [] : [`${name}=${JSON.stringify(short(value, 40))}`]
    }),
    ...STANDING.filter(name => element.hasAttribute(name)),
  ].join(' ')

// The text an element holds itself, not what the elements in it hold
const textOf = (element: Element): string =>
  short(
    [...element.childNodes]
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_TEXT,
  )

/**
 * Looks at the page every `everyMs` and calls `send` with its elements when they are not what was last sent.
 * Returns what stops it.
 */
export const reportDom = (send: (dom: ReportedDom) => void, { isOwn = file => !file.replace(/\\/g, '/').includes('/node_modules/'), everyMs = 3000 }: DomOptions = {}) => {
  let sent = ''
  // Looked at once, then again only when something on the page changed
  let isChanged = true

  // The component of the app's own an element is the outermost one of: the one whose template it is drawn by
  const componentOf = (element: Element): string => {
    let name = ''

    for (let at = (element as { __vueParentComponent?: Instance }).__vueParentComponent ?? null; at !== null && at.subTree?.el === element; at = at.parent) {
      const { __name, name: given, __file } = at.type

      if (__file !== undefined && isOwn(__file)) name = __name ?? given ?? /([^/\\]+)\.\w+$/.exec(__file)?.[1] ?? name
    }

    return name
  }

  const read = (): ReportedDom => {
    const elements: ReportedElement[] = []
    let left = 0

    const walk = (element: Element, depth: number) => {
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

    walk(document.body, 0)

    return { url: `${location.pathname}${location.search}`, title: document.title, elements, left }
  }

  const watcher = new MutationObserver(() => {
    isChanged = true
  })

  watcher.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })

  const look = () => {
    if (!isChanged) return

    isChanged = false

    try {
      const dom = read()
      const said = JSON.stringify(dom)

      if (said === sent) return

      sent = said
      send(dom)
    } catch {
      // Watching the page never breaks it
    }
  }

  const timer = setInterval(look, everyMs)

  look()

  return () => {
    clearInterval(timer)
    watcher.disconnect()
  }
}
