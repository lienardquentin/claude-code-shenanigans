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

  // A body goes on with its content-type, and only when there is one: the riders, quench and muster post none
  const headers: Record<string, string> = { 'x-request-id': rid }
  const carried = event.method === 'GET' || event.method === 'HEAD' ? undefined : (await readRawBody(event)) || undefined
  const kind = getRequestHeader(event, 'content-type')

  if (carried !== undefined && kind) headers['content-type'] = kind

  let answer: Response

  try {
    answer = await fetch(`${gondorUrl}/${errand}${getRequestURL(event).search}`, { method: event.method, headers, body: carried })
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
