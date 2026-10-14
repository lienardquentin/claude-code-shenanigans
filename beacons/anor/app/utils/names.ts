const NAMES: Record<string, string> = {
  'amon-din': 'Amon Dîn',
  eilenach: 'Eilenach',
  nardol: 'Nardol',
  erelas: 'Erelas',
  'min-rimmon': 'Min-Rimmon',
  calenhad: 'Calenhad',
  halifirien: 'Halifirien',
  anor: 'Anor',
  ithil: 'Ithil',
  orthanc: 'Orthanc',
  elostirion: 'Elostirion',
  osgiliath: 'Osgiliath',
}

/** A beacon or a stone as it is written in the annals. */
export const named = (name: string): string => NAMES[name] ?? name

/** Why an errand to the realm failed, in the realm's own words where it gave some. */
export const reasonOf = (failure: unknown): string => {
  const detail = (failure as { data?: { detail?: unknown } } | null)?.data?.detail
  // A refusal of what was sent is a list, each of what was wrong with one field: its message says why
  const said = Array.isArray(detail) ? (detail[0] as { msg?: unknown } | undefined)?.msg : detail

  return typeof said === 'string' ? said.replace(/^Value error, /, '') : 'no word came back'
}
