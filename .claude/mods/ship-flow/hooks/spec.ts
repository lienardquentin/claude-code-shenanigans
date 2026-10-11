/**
 * The commands of a spec's `## Verification` section, one a line, in order: what the run executes itself to decide
 * that a ticket is built. A fenced block's fences are dropped, as are list markers and blank lines.
 */
export const verificationOf = (spec: string): string[] => {
  const section = /^##\s+Verification\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(spec)?.[1] ?? ''

  return section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('```'))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/^`(.*)`$/, '$1'))
}
