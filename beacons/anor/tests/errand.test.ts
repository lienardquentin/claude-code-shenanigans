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
})
