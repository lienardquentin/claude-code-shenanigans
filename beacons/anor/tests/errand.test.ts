import { beforeEach, describe, expect, it, vi } from 'vitest'

// What Nitro would auto-import, stood in for: the proxy is a plain handler over a fake event
type FakeEvent = { method: string; headers: Record<string, string>; body?: string }

const fetch = vi.fn()

const header = (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]

beforeEach(() => {
  fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ beacon: 'amon-din', watch_next: 'eilenach' }), { status: 200 }))

  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => 'beacons/amon-din/light')
  vi.stubGlobal('getRequestHeader', header)
  vi.stubGlobal('getHeader', header)
  vi.stubGlobal('getRequestHeaders', (event: FakeEvent) => event.headers)
  vi.stubGlobal('readRawBody', async (event: FakeEvent) => event.body)
  vi.stubGlobal('useRuntimeConfig', () => ({ gondorUrl: 'http://gondor' }))
  vi.stubGlobal('getRequestURL', () => new URL('http://anor/api/realm/beacons/amon-din/light'))
  vi.stubGlobal('setResponseHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.stubGlobal('herald', vi.fn())
})

const errand = async (event: FakeEvent) => {
  const { default: handler } = await import('../server/api/realm/[...errand]')

  return (handler as unknown as (event: FakeEvent) => Promise<unknown>)(event)
}

const sent = () => fetch.mock.calls[0]![1] as RequestInit
const sentHeaders = () => new Headers(sent().headers)

describe('the errand to Gondor', () => {
  it('carries the body on to Gondor, with its content-type', async () => {
    const body = JSON.stringify({ keeper: 'Hirgon' })

    const answer = await errand({ method: 'POST', headers: { 'content-type': 'application/json' }, body })

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe('http://gondor/beacons/amon-din/light')
    expect(sent()).toEqual(expect.objectContaining({ method: 'POST', body }))
    expect(sentHeaders().get('content-type')).toBe('application/json')
    expect(answer).toEqual({ beacon: 'amon-din', watch_next: 'eilenach' })
  })

  it('still carries the request id along with a body', async () => {
    await errand({ method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'abcd1234' }, body: '{"keeper":null}' })

    expect(sentHeaders().get('x-request-id')).toBe('abcd1234')
  })

  it('adds no body nor content-type to a bodiless POST', async () => {
    await errand({ method: 'POST', headers: { 'x-request-id': 'abcd1234' } })

    expect(fetch).toHaveBeenCalledOnce()
    expect(sent().method).toBe('POST')
    expect(sent().body).toBeUndefined()
    expect(sentHeaders().get('content-type')).toBeNull()
    expect(sentHeaders().get('x-request-id')).toBe('abcd1234')
  })

  it('refuses a body past 16 KiB with a 413, and never sends it on', async () => {
    const said = await errand({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024) }, body: 'x' })

    expect(fetch).not.toHaveBeenCalled()
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 413)
    expect(said).toEqual({ detail: 'Gondor takes a body of 16384 bytes at most' })
  })

  it('refuses a length that is not a number of bytes with a 400', async () => {
    const said = await errand({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 'lots' }, body: '{}' })

    expect(fetch).not.toHaveBeenCalled()
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 400)
    expect(said).toEqual({ detail: "a body's length is a number of bytes, not lots" })
  })

  it('measures a body sent without its length, and refuses it past 16 KiB', async () => {
    const said = await errand({ method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"keeper":"${'x'.repeat(17 * 1024)}"}` })

    expect(fetch).not.toHaveBeenCalled()
    expect(said).toEqual({ detail: 'Gondor takes a body of 16384 bytes at most' })
  })
})
