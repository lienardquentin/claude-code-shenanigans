const isAbsolute = (path: string): boolean => /^([A-Za-z]:)?[\\/]/.test(path)

/**
 * The repo's root: the working directory itself, or the nearest folder above it that holds `.git`. Undefined when
 * none does, so a path is then left to the engine, relative to the working directory as before.
 */
export const rootOf = async (cwd: string, exists: (path: string) => Promise<boolean>): Promise<string | undefined> => {
  let dir = cwd.replace(/[\\/]+$/, '')

  while (dir !== '') {
    if (await exists(`${dir}/.git`)) return dir

    const parent = dir.replace(/[\\/][^\\/]*$/, '')

    if (parent === dir) return undefined
    dir = parent
  }

  return undefined
}

/** A path the run keeps in the repo, made absolute under the repo's root so a session started below it still finds it. */
export const underRoot = (root: string | undefined, path: string): string =>
  root === undefined || isAbsolute(path) ? path : `${root}/${path}`
