// How the parts' panes say what is long in few columns: a side pane is often fifty wide, and what it cuts is lost

/**
 * An issue's or a review's ref as a pane says it: its number, the repository being the one the pane is about
 * (`github:owner/repo#54` is `#54`, `review:github:owner/repo#7` is `review #7`). A ref with no number is said whole.
 */
export const shortRef = (ref: string): string => {
  // A lane's ref is its run's, and its task's id after a tilde
  const [, number, task] = /#(\d+)(?:~(\d+))?$/.exec(ref) ?? []

  return number === undefined ? ref : `${ref.startsWith('review:') ? 'review ' : ''}#${number}${task === undefined ? '' : ` task ${task}`}`
}

/**
 * A button's label with the key that presses it, as the runtime mod's say it: a Button that is not plain draws no hotkey,
 * and a pane has no other place to say it.
 */
export const keyed = (hotkey: string, text: string): string => `${hotkey} ${text}`

/** A text cut to a width, an ellipsis saying it was: for one line in a list, where the rest is shown when it is opened. */
export const clip = (text: string, width: number): string =>
  text.length <= width ? text : width <= 0 ? '' : width === 1 ? '…' : `${text.slice(0, width - 1).trimEnd()}…`

/** A time of today as a pane says it: hours and minutes. */
export const clockOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** A path as a pane says it: from the project's folder when it is under it, else whole. */
export const homePath = (path: string, root: string): string => {
  const home = root.replace(/\/+$/, '')

  return home !== '' && path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path
}
