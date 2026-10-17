// @ui-kit
// ui-kit part: json. Copy this file to a mod's `hooks/kit/json.ts`, then `import { json } from './kit/json'`.
// Self-contained: no imports.

/** The value as JSON, indented by two spaces; `undefined` is `'null'`. */
export const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? 'null'
