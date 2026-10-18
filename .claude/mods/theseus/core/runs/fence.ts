import { resolvedFrom } from '../paths'
import type { Task } from './work'

// Where a builder may work: its worktree, out of the mods' folders and the machine's private ones.

export const withinOf = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//, ''))

/**
 * A path in the mods' own source, which a builder leaves alone unless its task is about a mod: a fix to a mod that
 * stood in its way is not the run's, and would ride into its pull request.
 */
export const isModSource = (root: string, path: string, task: Pick<Task, 'files'> | undefined): boolean =>
  /^\.claude\/mods(\/|$)/.test(withinOf(root, path)) && !(task?.files ?? []).some(file => /^\.claude\/mods\//.test(file.replace(/^\.\//, '')))

/**
 * The minor findings a builder is sent back to tidy: those about a file its change wrote, named from the tree's root or
 * by its tail (`app.py:70` for `beacons/gondor/app.py`), and those that name no place. One about a file the change left
 * alone is no builder's to tidy.
 */
export const ownMinor = (found: readonly { where: string; line: string }[], tree: string, changed: readonly string[]): string[] =>
  found
    .filter(({ where }) => {
      const path = withinOf(tree, where.trim().replace(/:\d.*$/, '')).replace(/\/+$/, '')

      return path === '' || changed.some(file => file === path || file.endsWith(`/${path}`) || file.startsWith(`${path}/`))
    })
    .map(one => one.line)

/** Whether a path is outside the folder a builder works in, the run's worktree, once resolved from it. */
export const isOutside = (tree: string, path: string): boolean => {
  const whole = resolvedFrom(tree, path)

  return whole !== tree && !whole.startsWith(`${tree}/`)
}

/**
 * Whether a shell command leaves the run's worktree: it names the person's checkout outside it, a file of it named
 * whole, or walks out by a relative path (`cd ../..`, `cat ../../src/app.py`) or to the home folder (`cd`, `cd ~`). The
 * `cd`s of the command are followed in turn, from the worktree, as its words read; a command built to hide where it
 * goes can pass this, which is a fence for a builder that means well, not a sandbox.
 */
export const reachesOut = (root: string, tree: string, command: string): boolean => {
  if (root === '' || root === tree) return false

  for (let at = command.indexOf(root); at !== -1; at = command.indexOf(root, at + 1)) {
    const named = command.slice(at)
    const next = named.charAt(root.length)

    // Another folder that only begins like the checkout, such as /work/project-old, is not it
    if (next !== '' && !/[/\s'";&|)]/.test(next)) continue
    if (!(named.startsWith(tree) && /^($|[/\s'";&|)])/.test(named.slice(tree.length)))) return true
  }

  let here = tree

  for (const part of command.split(/&&|\|\||[;&|()\n]/)) {
    const words = part.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, '')).filter(word => word !== '')

    if (words[0] === 'cd' || words[0] === 'pushd') {
      const to = words.slice(1).find(word => !word.startsWith('-'))

      if (to === undefined || to.startsWith('~') || to.startsWith('$')) return true
      here = resolvedFrom(here, to)
      if (isOutside(tree, here)) return true
      continue
    }

    // A relative path that climbs out of where the command stands
    if (words.some(word => /(^|\/)\.\.(\/|$)/.test(word) && !/^[a-z+]+:\/\//i.test(word) && isOutside(tree, resolvedFrom(here, word.replace(/^[^=]*=/, ''))))) return true
  }

  return false
}
