// The commands of one `## <name>` section of a spec, one a line, in order. A fenced block's fences are dropped, as
// are list markers and blank lines.
const commandsOf = (spec: string, name: string): string[] => {
  const section = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(spec)?.[1] ?? ''

  return section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('```'))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/^`(.*)`$/, '$1'))
}

/**
 * The commands of a spec's `## Verification` section: what the run executes itself to decide that a ticket is
 * built.
 */
export const verificationOf = (spec: string): string[] => commandsOf(spec, 'Verification')

/**
 * The commands of a spec's `## Setup` section, if it has one: what the run executes in a ticket's fresh worktree
 * before its implementer starts, to put there what git does not track (installed dependencies, generated files).
 */
export const setupOf = (spec: string): string[] => commandsOf(spec, 'Setup')
