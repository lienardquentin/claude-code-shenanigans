// @ui-kit
// ui-kit part: yaml. Copy this file to a mod's `hooks/kit/yaml.ts`, then `import { yaml } from './kit/yaml'`.
// Self-contained: no imports.

// Plain YAML scalars: words, paths and dotted names that no parser reads as another type
const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/
const RESERVED = /^(true|false|null|yes|no|on|off|y|n)$/i

const isContainer = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !(value instanceof Date)

const isEmpty = (value: object): boolean =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0

const emptyOf = (value: object): string => (Array.isArray(value) ? '[]' : '{}')

const yamlString = (value: string): string => (PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value))

const yamlScalar = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string') return yamlString(value)
  if (typeof value === 'boolean') return String(value)
  // A bigint, symbol or function has no YAML form of its own: its string, quoted
  return JSON.stringify(String(value))
}

const yamlBlock = (value: object, pad: string): string[] => {
  if (isEmpty(value)) return [`${pad}${emptyOf(value)}`]

  if (Array.isArray(value)) {
    return value.flatMap((item): string[] => {
      if (!isContainer(item)) return [`${pad}- ${yamlScalar(item)}`]
      if (isEmpty(item)) return [`${pad}- ${emptyOf(item)}`]
      // The first line of a nested block rides on the dash
      const [first = '', ...rest] = yamlBlock(item, `${pad}  `)
      return [`${pad}- ${first.slice(pad.length + 2)}`, ...rest]
    })
  }

  return Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .flatMap((entry): string[] => {
      const [key, field] = entry
      const name = yamlString(key)
      if (!isContainer(field)) return [`${pad}${name}: ${yamlScalar(field)}`]
      if (isEmpty(field)) return [`${pad}${name}: ${emptyOf(field)}`]
      return [`${pad}${name}:`, ...yamlBlock(field, `${pad}  `)]
    })
}

/** The value as YAML: scalars, nested objects and lists; a string is quoted only where a parser would misread it. */
export const yaml = (value: unknown): string => (isContainer(value) ? yamlBlock(value, '').join('\n') : yamlScalar(value))
