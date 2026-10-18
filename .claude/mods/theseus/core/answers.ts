// How an agent's answer is read, whichever part sent it.

/**
 * The json an agent's answer holds in fences, each block's text in order: the blocks marked `json` and those marked
 * nothing. A fence opens at the start of a line, its language after it, and closes on a line of its own; a block of
 * another language (code it quotes) is passed over whole, so its closing fence never opens one.
 */
export const fencedJson = (answer: string): string[] => {
  const blocks: string[] = []
  let open: { language: string; lines: string[] } | null = null

  for (const line of answer.split('\n')) {
    if (open === null) {
      const fence = /^\s{0,3}```\s*([\w+-]*)/.exec(line)

      if (fence !== null) open = { language: (fence[1] ?? '').toLowerCase(), lines: [] }
      continue
    }

    // A block closes on a fence of its own, or one at the end of its last line
    const isClosing = /^\s{0,3}```\s*$/.test(line)

    if (!isClosing && !/```\s*$/.test(line)) {
      open.lines.push(line)
      continue
    }

    if (!isClosing) open.lines.push(line.replace(/```\s*$/, ''))
    if (open.language === '' || open.language === 'json') blocks.push(open.lines.join('\n'))
    open = null
  }

  return blocks
}
