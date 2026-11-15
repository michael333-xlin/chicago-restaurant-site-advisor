// Chicago's address grid: State St (0 E/W) and Madison St (0 N/S) are the baselines,
// and 800 address numbers make one mile. Major arterials sit on the mile and half-mile lines.
// Converting lat/lon to grid numbers is approximate (the grid is not perfectly aligned with
// lat/lon), so labels are shown with "≈".

const STATE_LON = -87.62775
const MADISON_LAT = 41.88183
const MILE_LAT = 0.014493
const MILE_LON = 0.01942

// N-S streets keyed by grid number west of State (negative = east).
const NS_STREETS: [number, string][] = [
  [-100, 'Michigan Ave'], [0, 'State St'], [200, 'Wells St'], [800, 'Halsted St'], [1200, 'Racine Ave'],
  [1600, 'Ashland Ave'], [2000, 'Damen Ave'], [2400, 'Western Ave'], [2800, 'California Ave'],
  [3200, 'Kedzie Ave'], [3600, 'Central Park Ave'], [4000, 'Pulaski Rd'], [4400, 'Kostner Ave'],
  [4800, 'Cicero Ave'], [5200, 'Laramie Ave'], [5600, 'Central Ave'], [6000, 'Austin Ave'],
  [6400, 'Narragansett Ave'], [6800, 'Oak Park Ave'], [7200, 'Harlem Ave'], [7600, 'Cumberland Ave'],
  [8000, 'Canfield Ave'],
]

// E-W streets keyed by grid number north of Madison (negative = south).
const EW_STREETS: [number, string][] = [
  [7600, 'Howard St'], [7200, 'Touhy Ave'], [6800, 'Pratt Blvd'], [6400, 'Devon Ave'], [6000, 'Peterson Ave'],
  [5600, 'Bryn Mawr Ave'], [5200, 'Foster Ave'], [4800, 'Lawrence Ave'], [4400, 'Montrose Ave'],
  [4000, 'Irving Park Rd'], [3600, 'Addison St'], [3200, 'Belmont Ave'], [2800, 'Diversey Pkwy'],
  [2400, 'Fullerton Ave'], [2000, 'Armitage Ave'], [1600, 'North Ave'], [1200, 'Division St'],
  [800, 'Chicago Ave'], [400, 'Kinzie St'], [0, 'Madison St'], [-500, 'Congress Pkwy'], [-1200, 'Roosevelt Rd'],
  [-1800, '18th St'], [-2200, 'Cermak Rd'], [-2600, '26th St'], [-3100, '31st St'], [-3500, '35th St'],
  [-3900, 'Pershing Rd'], [-4300, '43rd St'], [-4700, '47th St'], [-5100, '51st St'], [-5500, 'Garfield Blvd'],
  [-5900, '59th St'], [-6300, '63rd St'], [-6700, '67th St'], [-7100, '71st St'], [-7500, '75th St'],
  [-7900, '79th St'], [-8300, '83rd St'], [-8700, '87th St'], [-9100, '91st St'], [-9500, '95th St'],
  [-9900, '99th St'], [-10300, '103rd St'], [-10700, '107th St'], [-11100, '111th St'], [-11500, '115th St'],
  [-11900, '119th St'], [-12700, '127th St'], [-13000, '130th St'], [-13400, '134th St'],
]

// Extra street names used only for labels inside the Loop / Near North / South Loop, where the grid is denser.
const NS_DOWNTOWN: [number, string][] = [
  [-300, 'Columbus Dr'], [100, 'Clark St'], [150, 'LaSalle St'], [300, 'Franklin St'], [500, 'Canal St'], [600, 'Jefferson St'],
]
const EW_DOWNTOWN: [number, string][] = [
  [1000, 'Oak St'], [700, 'Huron St'], [600, 'Ohio St'], [530, 'Grand Ave'], [200, 'Lake St'], [100, 'Washington St'],
  [-100, 'Monroe St'], [-200, 'Adams St'], [-300, 'Jackson Blvd'], [-800, 'Polk St'],
]

export type GridPos = { ns: number; ew: number } // grid numbers: ns > 0 north, ew > 0 west

export function toGrid(lat: number, lon: number): GridPos {
  return {
    ns: ((lat - MADISON_LAT) / MILE_LAT) * 800,
    ew: ((STATE_LON - lon) / MILE_LON) * 800,
  }
}

const nearest = (v: number, list: [number, string][]) =>
  list.reduce((best, s) => (Math.abs(s[0] - v) < Math.abs(best[0] - v) ? s : best), list[0])

/** Distance (in miles) from a grid position to the nearest arterial in each direction. */
export function arterialDistance(g: GridPos): { toNS: number; toEW: number } {
  return {
    toNS: Math.abs(nearest(g.ew, NS_STREETS)[0] - g.ew) / 800,
    toEW: Math.abs(nearest(g.ns, EW_STREETS)[0] - g.ns) / 800,
  }
}

const dir = (v: number, pos: string, neg: string) => (v >= 0 ? pos : neg)

export function streetLabel(lat: number, lon: number) {
  const g = toGrid(lat, lon)
  const downtown = g.ns > -1300 && g.ns < 1700 && g.ew > -700 && g.ew < 700
  const ns = nearest(g.ew, downtown ? [...NS_STREETS, ...NS_DOWNTOWN] : NS_STREETS)
  const ew = nearest(g.ns, downtown ? [...EW_STREETS, ...EW_DOWNTOWN] : EW_STREETS)
  const dNS = Math.abs(ns[0] - g.ew), dEW = Math.abs(ew[0] - g.ns)
  const short = (n: string) => n.replace(/ (Ave|St|Rd|Blvd|Pkwy|Dr)$/, '')
  const hundred = (v: number) => Math.floor(Math.abs(v) / 100) * 100
  const nsName = `${dir(g.ns, 'N', 'S')} ${ns[1]}`
  const ewName = `${dir(g.ew, 'W', 'E')} ${ew[1]}`
  // Intersection when both streets are within ~1 block; otherwise a Chicago-style block address on the nearer street.
  const label =
    dNS < 90 && dEW < 90
      ? `${short(ns[1])} & ${short(ew[1])}`
      : dEW <= dNS
        ? `${hundred(g.ew)} ${dir(g.ew, 'W', 'E')} ${short(ew[1])}`
        : `${hundred(g.ns)} ${dir(g.ns, 'N', 'S')} ${short(ns[1])}`
  const round25 = (v: number) => Math.round(Math.abs(v) / 25) * 25
  return {
    ns: nsName,
    ew: ewName,
    label,
    grid: `≈ ${round25(g.ns)} ${dir(g.ns, 'N', 'S')} · ${round25(g.ew)} ${dir(g.ew, 'W', 'E')}`,
  }
}
