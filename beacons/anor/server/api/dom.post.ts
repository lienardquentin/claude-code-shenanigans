type Reported = { url?: unknown; title?: unknown; elements?: unknown; left?: unknown }

const cut = (value: unknown, most: number): string => (typeof value === 'string' ? value.slice(0, most) : '')

// The page the browser reports is said here, one line, in the form a watcher of the logs keeps the last
// of: "palantir":"dom", the page's address and title, and its elements, each as how deep it is nested, what it is,
// what it is to a reader, its own text, and the component it is the outermost element of.
export default defineEventHandler(async event => {
  const { url, title, elements, left } = (await readBody<Reported>(event)) ?? {}

  herald('debug', `page ${cut(url, 200)} drawn`, {
    palantir: 'dom',
    url: cut(url, 200),
    title: cut(title, 120),
    elements: (Array.isArray(elements) ? elements : [])
      .slice(0, 300)
      .filter((element): element is unknown[] => Array.isArray(element) && typeof element[0] === 'number')
      .map(([depth, tag, attributes, text, component]) => [Math.max(0, Math.min(60, Math.round(depth as number))), cut(tag, 80), cut(attributes, 200), cut(text, 80), cut(component, 60)]),
    left: typeof left === 'number' && left > 0 ? Math.round(left) : 0,
  })

  setResponseStatus(event, 204)

  return null
})
