// light the beacon
const beacon = lightBeacon()

export const BeaconList = ({ beacons }: { beacons: string[] }) => {
  try {
    record(beacons)
  } catch {}
  return <ul>{beacons.map((name) => <li key={name}>{name}</li>)}</ul>
}

export function processData(info: string) {
  if (info == null) return
  return info
}
