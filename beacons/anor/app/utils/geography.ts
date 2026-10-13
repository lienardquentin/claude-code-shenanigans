import type { Feature, FeatureCollection, Position } from 'geojson'

type Miles = [east: number, north: number]

/**
 * Middle-earth has no longitude. Everything here is set down in miles east and north of Minas Tirith, read by eye
 * off the maps of the Red Book, and laid on the equator at 69 miles to the degree: the map's own scale reads true.
 * It is a sketch, good for telling Anórien from Eriador and no more.
 */
export const at = ([east, north]: Miles): Position => [east / 69, north / 69]

const line = (kind: string, path: Miles[], properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  properties: { kind, ...properties },
  geometry: { type: 'LineString', coordinates: path.map(at) },
})

const shape = (kind: string, ring: Miles[], properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  properties: { kind, ...properties },
  geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!].map(at)] },
})

const spot = (kind: string, where: Miles, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  properties: { kind, ...properties },
  geometry: { type: 'Point', coordinates: at(where) },
})

/** The seven beacon-hills, on the north side of the White Mountains. */
export const BEACON_HILLS: Record<string, Miles> = {
  'amon-din': [-22, 28],
  eilenach: [-50, 40],
  nardol: [-78, 46],
  erelas: [-104, 50],
  'min-rimmon': [-130, 52],
  calenhad: [-156, 52],
  halifirien: [-184, 50],
}

const MINAS_TIRITH: Miles = [0, 0]
const EDORAS: Miles = [-275, 52]

/** Where each seeing-stone was kept. Osgiliath's is in the river, and is marked where it went in. */
export const STONE_SEATS: Record<string, Miles> = {
  anor: MINAS_TIRITH,
  ithil: [48, -2],
  osgiliath: [18, 4],
  orthanc: [-365, 165],
  elostirion: [-800, 640],
}

/** The Great West Road from Edoras to the Gate of Minas Tirith: the way the Rohirrim ride. */
const MUSTER_ROAD: Miles[] = [EDORAS, [-245, 58], [-215, 60], [-186, 58], [-158, 60], [-132, 60], [-106, 58], [-80, 54], [-52, 48], [-25, 36], [-10, 22], MINAS_TIRITH]

/** The point a part of the way (0 to 1) along the road from Edoras to Minas Tirith. */
export const onTheRoad = (part: number): Position => {
  const legs = MUSTER_ROAD.slice(1).map((end, index) => ({ start: MUSTER_ROAD[index]!, end, miles: Math.hypot(end[0] - MUSTER_ROAD[index]![0], end[1] - MUSTER_ROAD[index]![1]) }))
  let left = part * legs.reduce((sum, { miles }) => sum + miles, 0)

  for (const { start, end, miles } of legs) {
    if (left <= miles) return at([start[0] + ((end[0] - start[0]) * left) / miles, start[1] + ((end[1] - start[1]) * left) / miles])

    left -= miles
  }

  return at(MINAS_TIRITH)
}

/** The fire's road: Minas Tirith, then each beacon east to west. The stretch between two fires that burn is drawn. */
export const relayOf = (lit: Set<string>): Feature => {
  const hills = Object.entries(BEACON_HILLS)
  const stretches = hills.flatMap(([name, hill], index) => {
    const [before, from] = hills[index - 1] ?? [name, MINAS_TIRITH]

    return lit.has(name) && lit.has(before) ? [[at(from), at(hill)]] : []
  })

  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: stretches } }
}

/** What each view of the map holds, as west, south, east, north. */
export const VIEWS = {
  beacons: [...at([-300, -45]), ...at([75, 120])],
  middleEarth: [...at([-1010, -420]), ...at([340, 780])],
} as const satisfies Record<string, Position>

const COAST: Miles[] = [
  [-940, 800], [-960, 720], [-950, 680], [-900, 665], [-860, 660], [-900, 645], [-960, 630], [-970, 560], [-940, 480], [-880, 420],
  [-820, 380], [-760, 330], [-720, 270], [-690, 200], [-660, 130], [-640, 70], [-620, 30], [-600, -20], [-570, -70], [-540, -110],
  [-530, -150], [-490, -130], [-450, -100], [-400, -95], [-340, -110], [-290, -125], [-255, -140], [-245, -158], [-225, -150],
  [-215, -125], [-190, -120], [-180, -150], [-150, -180], [-110, -195], [-85, -200], [-80, -230], [-100, -280], [-140, -330],
  [-190, -380], [-200, -460], [400, -460], [400, 800],
]

export const REALM: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    shape('land', COAST),
    shape('land', [[-145, -225], [-125, -220], [-115, -240], [-135, -255], [-150, -242]]),
    shape('shadow', [[50, 118], [300, 118], [320, -130], [120, -130], [80, -100], [62, -50], [55, 0], [52, 40], [55, 80]]),
    shape('lake', [[170, -60], [230, -50], [250, -80], [210, -105], [170, -90]]),

    shape('forest', [[-330, 250], [-290, 265], [-255, 240], [-250, 205], [-285, 190], [-325, 205]], { label: 'Fangorn' }),
    shape('forest', [[-215, 415], [-180, 420], [-165, 395], [-185, 375], [-215, 385]], { label: 'Lothlórien' }),
    shape('forest', [[-130, 760], [-140, 640], [-120, 520], [-90, 440], [-40, 430], [20, 470], [40, 560], [30, 680], [40, 760]], { label: 'Mirkwood' }),
    shape('forest', [[-48, 40], [-40, 22], [-12, 18], [-8, 36], [-30, 46]], { label: 'Drúadan Forest', rank: 2 }),
    shape('forest', [[-196, 40], [-174, 40], [-170, 58], [-190, 62]], { label: 'Firien Wood', rank: 2 }),

    line('river', [[-210, 740], [-200, 620], [-180, 500], [-165, 400], [-120, 330], [-90, 260], [-60, 200], [-40, 150], [-25, 110], [0, 60], [15, 20], [18, 4], [12, -15], [-5, -50], [-20, -95], [-25, -125], [-50, -165], [-85, -200]], { label: 'Anduin' }),
    line('river', [[-300, 215], [-240, 170], [-170, 130], [-100, 112], [-28, 112]], { label: 'Entwash' }),
    line('river', [[-365, 165], [-365, 110], [-400, 70], [-470, 50], [-560, 40], [-620, 30]], { label: 'Isen' }),
    line('river', [[-186, 44], [-190, 90], [-170, 130]], { label: 'Mering Stream' }),
    line('river', [[-330, 640], [-420, 520], [-520, 380], [-600, 240], [-660, 130]], { label: 'Greyflood' }),
    line('river', [[-700, 720], [-680, 620], [-650, 520], [-690, 380], [-720, 270]], { label: 'Brandywine' }),

    line('range', [[-6, -4], [-30, 10], [-60, 22], [-95, 30], [-130, 34], [-165, 34], [-200, 32], [-240, 30], [-275, 34], [-310, 45], [-340, 60], [-375, 62], [-410, 50]], { label: 'Ered Nimrais' }),
    line('range', [[-345, 38], [-400, -10], [-450, -70], [-490, -115]]),
    line('range', [[-345, 185], [-330, 260], [-300, 350], [-290, 440], [-285, 540], [-290, 640], [-300, 740]], { label: 'Misty Mountains' }),
    line('range', [[50, 115], [55, 80], [52, 40], [55, 0], [62, -50], [80, -100], [120, -130]], { label: 'Ephel Dúath' }),
    line('range', [[56, 122], [100, 127], [170, 127], [250, 122], [300, 118]], { label: 'Ered Lithui' }),
    line('range', [[-900, 560], [-908, 625]], { label: 'Ered Luin' }),
    line('range', [[-905, 690], [-890, 770]]),

    line('road', MUSTER_ROAD, { label: 'The Great West Road' }),
    line('road', [EDORAS, [-310, 70], [-350, 95], [-365, 110], [-365, 165]]),
    line('road', [[-365, 110], [-420, 250], [-500, 420], [-570, 650], [-680, 640], [-800, 640], [-860, 655]]),

    spot('region', [-120, -70], { label: 'GONDOR' }),
    spot('region', [-250, 115], { label: 'ROHAN' }),
    spot('region', [175, 40], { label: 'MORDOR' }),
    spot('region', [-610, 520], { label: 'ERIADOR' }),
    spot('region', [-30, 300], { label: 'RHOVANION' }),
    spot('region', [10, -320], { label: 'HARAD' }),
    spot('region', [-520, 170], { label: 'ENEDWAITH' }),
    spot('sea', [-850, 120], { label: 'Belegaer\nthe Great Sea' }),
    spot('sea', [-360, -230], { label: 'Bay of Belfalas' }),

    spot('place', MINAS_TIRITH, { label: 'Minas Tirith', rank: 1 }),
    spot('place', EDORAS, { label: 'Edoras', rank: 1 }),
    spot('place', STONE_SEATS.orthanc!, { label: 'Isengard', rank: 1 }),
    spot('place', [140, 45], { label: 'Barad-dûr', rank: 1 }),
    spot('place', [-235, -150], { label: 'Dol Amroth', rank: 1 }),
    spot('place', [-300, 640], { label: 'Rivendell', rank: 1 }),
    spot('place', [-680, 640], { label: 'Hobbiton', rank: 1 }),
    spot('place', STONE_SEATS.elostirion!, { label: 'The Tower Hills', rank: 1 }),
    spot('place', [-290, 440], { label: 'Moria', rank: 1 }),
    spot('place', STONE_SEATS.osgiliath!, { label: 'Osgiliath', rank: 2 }),
    spot('place', STONE_SEATS.ithil!, { label: 'Minas Morgul', rank: 2 }),
    spot('place', [-335, 72], { label: "Helm's Deep", rank: 2 }),
    spot('place', [-25, -125], { label: 'Pelargir', rank: 2 }),
    spot('place', [2, 52], { label: 'Cair Andros', rank: 2 }),
    spot('place', [105, 30], { label: 'Orodruin', rank: 2 }),
    spot('place', [50, 116], { label: 'The Morannon', rank: 2 }),
    spot('place', [-40, 150], { label: 'Rauros', rank: 2 }),
    spot('place', [-570, 650], { label: 'Bree', rank: 2 }),
    spot('place', [-860, 655], { label: 'The Grey Havens', rank: 2 }),

    ...Object.entries(STONE_SEATS).map(([stone, seat]) => spot('stone', seat, { stone })),
  ],
}
