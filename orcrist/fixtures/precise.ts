type Options = { search?: string } | undefined

export function search(options: Options, text: string) {
  if (options === undefined) return ''
  const first = 'amon-din' // light eilenach
  lightBeacon('eilenach')
  try {
    lightBeacon(first)
  } catch {
    return
  }
  if (text == null) return ''
  return text
}

export function either<T>(value: T, fallback: T): T {
  return value === null ? fallback : value
}
