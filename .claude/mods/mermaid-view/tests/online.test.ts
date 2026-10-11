import { describe, expect, test } from 'claude-code/testing'

import { MAX_ADDRESS, adler32, base64url, encodeDiagram, onlineAddresses, utf8, zlibStored } from '../hooks/online'

// The code of a stored zlib stream, read back: the header, each block's length and bytes, and the checksum
const unzlib = (bytes: Uint8Array): Uint8Array => {
  const out: number[] = []
  let at = 2

  for (;;) {
    const last = (bytes[at] as number) & 1
    const length = (bytes[at + 1] as number) | ((bytes[at + 2] as number) << 8)
    const complement = (bytes[at + 3] as number) | ((bytes[at + 4] as number) << 8)

    expect(complement).toBe(~length & 0xffff)
    for (let index = 0; index < length; index += 1) out.push(bytes[at + 5 + index] as number)
    at += 5 + length
    if (last === 1) break
  }

  const result = new Uint8Array(out)
  const sum = ((bytes[at] as number) << 24) | ((bytes[at + 1] as number) << 16) | ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number)

  expect(sum >>> 0).toBe(adler32(result))

  return result
}

const fromBase64url = (text: string): Uint8Array => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const out: number[] = []
  let bits = 0
  let held = 0

  for (const char of text) {
    held = (held << 6) | alphabet.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((held >> bits) & 0xff)
    }
  }

  return new Uint8Array(out)
}

describe('addresses that have a hosted Mermaid draw a diagram', () => {
  test('the Adler-32 checksum is the standard one', () => {
    // the value zlib's own documentation gives for "Wikipedia"
    expect(adler32(utf8('Wikipedia'))).toBe(0x11e60398)
    expect(adler32(utf8(''))).toBe(1)
  })

  test('a zlib stream in a stored block has the bytes a deflater gives for one', () => {
    // "a" as zlib writes it with no compression: the header, one final stored block, and the checksum
    expect([...zlibStored(utf8('a'))]).toEqual([0x78, 0x01, 0x01, 0x01, 0x00, 0xfe, 0xff, 0x61, 0x00, 0x62, 0x00, 0x62])
  })

  test('a text longer than a block is split in blocks, and read back whole', () => {
    const long = 'x'.repeat(70000)
    const stream = zlibStored(utf8(long))

    expect(unzlib(stream).length).toBe(70000)
    expect(stream[2]).toBe(0)
  })

  test('encodes the way URLs need: base64 with - and _ for + and /, and no padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_')
    expect(base64url(utf8('Ma'))).toBe('TWE')
    expect(base64url(utf8('M'))).toBe('TQ')
    expect(base64url(utf8('Man'))).toBe('TWFu')
  })

  test('encodes characters outside ASCII as UTF-8', () => {
    expect([...utf8('é')]).toEqual([0xc3, 0xa9])
    expect([...utf8('→')]).toEqual([0xe2, 0x86, 0x92])
    expect([...utf8('😀')]).toEqual([0xf0, 0x9f, 0x98, 0x80])
  })

  test('a diagram goes into the address as the editor\'s state, which reads back as the diagram', () => {
    const source = 'graph TD; A[Start] --> B["Näive → end"]'
    const encoded = encodeDiagram(source)

    expect(encoded.startsWith('pako:')).toBe(true)

    const state = JSON.parse(new TextDecoder().decode(unzlib(fromBase64url(encoded.slice('pako:'.length)))))

    expect(state.code).toBe(source)
    expect(JSON.parse(state.mermaid)).toEqual({ theme: 'default' })
  })

  test('has an address that draws it and one that edits it, both https', () => {
    const addresses = onlineAddresses('graph TD; A --> B')

    expect(addresses?.view).toMatch(/^https:\/\/mermaid\.ink\/svg\/pako:[A-Za-z0-9_-]+$/)
    expect(addresses?.edit).toMatch(/^https:\/\/mermaid\.live\/edit#pako:[A-Za-z0-9_-]+$/)
  })

  test('has none for a diagram too long for an address', () => {
    expect(onlineAddresses(`graph TD; ${'A --> B; '.repeat(2000)}`)).toBeUndefined()
    expect(MAX_ADDRESS).toBeGreaterThan(1000)
  })
})
