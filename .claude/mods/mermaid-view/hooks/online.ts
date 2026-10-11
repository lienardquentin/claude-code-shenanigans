// Addresses that have a hosted Mermaid draw a diagram, so that it can be opened from any machine: the address is an
// https link, which every surface draws as one and a browser on the person's own machine opens, whether or not the
// session runs over ssh. What they hold is the diagram's text, so opening one sends it to that service.
//
// The format is the one of the Mermaid Live Editor, which mermaid.ink takes too: the JSON of the editor's state,
// deflated as zlib and written as URL-safe base64, after `pako:`.

/** The bytes of a text, as UTF-8. */
export const utf8 = (text: string): Uint8Array => {
  const bytes: number[] = []

  for (const char of text) {
    const code = char.codePointAt(0) as number

    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }

  return new Uint8Array(bytes)
}

/** The Adler-32 checksum a zlib stream ends with. */
export const adler32 = (bytes: Uint8Array): number => {
  let a = 1
  let b = 0

  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }

  return ((b << 16) | a) >>> 0
}

/**
 * The bytes as a zlib stream, in stored blocks: a valid stream any inflater reads, though not a smaller one. A
 * diagram's text is short, and this takes no compressor.
 */
export const zlibStored = (bytes: Uint8Array): Uint8Array => {
  const out: number[] = [0x78, 0x01]
  const BLOCK = 65535

  for (let start = 0; start === 0 || start < bytes.length; start += BLOCK) {
    const block = bytes.subarray(start, Math.min(start + BLOCK, bytes.length))
    const last = start + BLOCK >= bytes.length

    out.push(last ? 1 : 0, block.length & 0xff, block.length >> 8, ~block.length & 0xff, (~block.length >> 8) & 0xff)
    for (const byte of block) out.push(byte)
  }

  const sum = adler32(bytes)
  out.push((sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff)

  return new Uint8Array(out)
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** URL-safe base64 without padding. */
export const base64url = (bytes: Uint8Array): string => {
  let out = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const triple = ((bytes[index] as number) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)

    out += ALPHABET[(triple >> 18) & 63] as string
    out += ALPHABET[(triple >> 12) & 63] as string
    if (index + 1 < bytes.length) out += ALPHABET[(triple >> 6) & 63] as string
    if (index + 2 < bytes.length) out += ALPHABET[triple & 63] as string
  }

  return out
}

/** The editor's state for a diagram, deflated and written as the address expects it. */
export const encodeDiagram = (source: string): string =>
  `pako:${base64url(zlibStored(utf8(JSON.stringify({ code: source, mermaid: JSON.stringify({ theme: 'default' }) }))))}`

/** A Link takes an address of at most 2048 characters, and more may be refused by a server or a browser too. */
export const MAX_ADDRESS = 2000

/** The address that draws the diagram as an SVG, and the one that opens it in the editor; `undefined` if too long. */
export const onlineAddresses = (source: string): { view: string; edit: string } | undefined => {
  const encoded = encodeDiagram(source)
  const view = `https://mermaid.ink/svg/${encoded}`
  const edit = `https://mermaid.live/edit#${encoded}`

  return view.length > MAX_ADDRESS || edit.length > MAX_ADDRESS ? undefined : { view, edit }
}
