// Paths as the workflow reads them, whatever machine it runs on.

/** A path as it lands from a folder: absolute, its `.` and `..` walked. */
export const resolvedFrom = (cwd: string, path: string): string => {
  const parts: string[] = []

  for (const part of (/^([A-Za-z]:)?\//.test(path) ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }

  return `/${parts.join('/')}`
}
