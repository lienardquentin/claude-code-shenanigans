export interface Store {
  save(text: string): void
}

export class Disk implements Store {
  save(text: string) {
    if (text == null) return
    if (typeof text !== 'string') return
    const length = text?.length
    write(text, length).catch(() => {})
  }
}

export function processData(info: string) {
  try {
    light(info, 'Hirgon')
  } catch {}
  light(info, 'Hirgon')
}
