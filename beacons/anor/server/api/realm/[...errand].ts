import { randomUUID } from 'node:crypto'

// Every errand of the page goes to Gondor through here, under an id that Gondor carries on to Rohan: one click
// reads as one story across the three logs.
export default defineEventHandler(async event => {
  const errand = getRouterParam(event, 'errand') ?? ''
  const rid = getRequestHeader(event, 'x-request-id') ?? randomUUID().slice(0, 8)
  const { gondorUrl } = useRuntimeConfig(event)
  const said = `${event.method} /${errand}`
  const started = Date.now()

  setResponseHeader(event, 'x-request-id', rid)

  let answer: Response

  try {
    answer = await fetch(`${gondorUrl}/${errand}${getRequestURL(event).search}`, { method: event.method, headers: { 'x-request-id': rid } })
  } catch {
    herald('error', `${said}: Gondor does not answer`, { rid })
    setResponseStatus(event, 502)

    return { detail: 'Gondor does not answer' }
  }

  const body: unknown = await answer.json().catch(() => ({}))

  herald(answer.status >= 500 ? 'error' : answer.status >= 400 ? 'warn' : 'info', `${said} -> ${answer.status} in ${Date.now() - started}ms`, { rid })
  setResponseStatus(event, answer.status)

  return body
})
