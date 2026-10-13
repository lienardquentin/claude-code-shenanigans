type Reported = { component?: unknown; chain?: unknown; values?: unknown; whole?: unknown; count?: unknown }

// The renders the page reports are said here, one line each, in the form a watcher of the logs counts them by:
// "palantir":"render", the component, the chain that led to the render, the cause first, and the value each step
// of it held, short, and whole where the short one leaves some out.
export default defineEventHandler(async event => {
  const { renders } = (await readBody<{ renders?: unknown }>(event)) ?? {}

  for (const { component, chain, values, whole, count } of (Array.isArray(renders) ? renders : []).slice(0, 30) as Reported[]) {
    if (typeof component !== 'string' || !Array.isArray(chain)) continue

    herald('debug', `${component.slice(0, 80)} rendered`, {
      palantir: 'render',
      component: component.slice(0, 80),
      chain: chain.slice(0, 12).map(step => String(step).slice(0, 120)),
      values: (Array.isArray(values) ? values : []).slice(0, 12).map(value => (typeof value === 'string' ? value.slice(0, 120) : null)),
      // Past its length a whole value would be no JSON any more: it is left out
      whole: (Array.isArray(whole) ? whole : []).slice(0, 12).map(value => (typeof value === 'string' && value.length <= 2000 ? value : null)),
      count: typeof count === 'number' && count >= 1 ? Math.round(count) : 1,
    })
  }

  setResponseStatus(event, 204)

  return null
})
