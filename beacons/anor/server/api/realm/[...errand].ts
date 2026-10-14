import { randomUUID } from 'node:crypto'

// The page sends Gondor a keeper's name at most: a body said to be past this is refused before it is read, and one
// that does not say its length is refused once read
const LARGEST_BODY = 16 * 1024

// Every errand of the page goes to Gondor through here, under an id that Gondor carries on to Rohan: one click
// reads as one story across the three logs.
export default defineEventHandler(async event => {
  const errand = getRouterParam(event, 'errand') ?? ''
  const rid = getRequestHeader(event, 'x-request-id') ?? randomUUID().slice(0, 8)
  const { gondorUrl } = useRuntimeConfig(event)
  const said = `${event.method} /${errand}`
  const started = Date.now()

  setResponseHeader(event, 'x-request-id', rid)

  const isTooLarge = (length: number) => {
    if (length <= LARGEST_BODY) return false

    herald('warn', `${said}: a body of ${length} bytes is refused`, { rid })
    setResponseStatus(event, 413)

    return true
  }

  // A body goes on with its content-type, and only when there is one: the riders, quench and muster post none
  const headers: Record<string, string> = { 'x-request-id': rid }
  const hasBody = event.method !== 'GET' && event.method !== 'HEAD'

  const length = getRequestHeader(event, 'content-length')

  if (hasBody && length !== undefined && !/^\d+$/.test(length.trim())) {
    setResponseStatus(event, 400)

    return { detail: `a body's length is a number of bytes, not ${length}` }
  }
  if (hasBody && isTooLarge(Number(length ?? 0))) return { detail: `Gondor takes a body of ${LARGEST_BODY} bytes at most` }

  const carried = hasBody ? (await readRawBody(event)) || undefined : undefined

  // A body sent without saying its length is measured once read
  if (carried !== undefined && isTooLarge(Buffer.byteLength(carried))) return { detail: `Gondor takes a body of ${LARGEST_BODY} bytes at most` }

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
