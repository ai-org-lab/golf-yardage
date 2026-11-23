/** C-015: pure golf yardage engine. No browser globals / network access. */
export const DEFAULT_CLUBS = Object.freeze([
  { name: '1W', carry: 245, type: 'wood', estimated: false },
  { name: '3W', carry: 225, type: 'wood', estimated: true },
  { name: '4I', carry: 193, type: 'long', estimated: true },
  { name: '5I', carry: 182, type: 'long', estimated: true },
  { name: '6I', carry: 170, type: 'mid', estimated: false },
  { name: '7I', carry: 158, type: 'mid', estimated: true },
  { name: '8I', carry: 145, type: 'short', estimated: true },
  { name: '9I', carry: 132, type: 'short', estimated: false },
  { name: 'PW', carry: 125, type: 'wedge', estimated: true },
  { name: '52°', carry: 117, type: 'wedge', estimated: false },
  { name: '58°', carry: 100, type: 'wedge', estimated: true },
]);

export const ANGLES = Object.freeze({ wood: 38, long: 42, mid: 45, short: 48, wedge: 51 });

export function validClubs(clubs = DEFAULT_CLUBS) {
  return clubs.filter(c => typeof c.name === 'string' && Object.hasOwn(ANGLES, c.type)
    && c.carry !== '' && c.carry !== null && Number.isFinite(Number(c.carry)) && Number(c.carry) > 0)
    .map(c => ({ ...c, carry: Number(c.carry) }))
    .sort((a, b) => b.carry - a.carry); // stable: equal-distance ties favour the longer-listed club
}

export function nearest(distance, clubs = DEFAULT_CLUBS) {
  const available = validClubs(clubs);
  if (!available.length) return null;
  let winner = available[0];
  for (const club of available.slice(1)) {
    if (Math.abs(club.carry - distance) < Math.abs(winner.carry - distance)) winner = club;
  }
  return winner;
}

export function category(distance, clubs = DEFAULT_CLUBS) {
  const club = nearest(distance, clubs);
  if (club) return club.type;
  return distance >= 185 ? 'wood' : distance >= 160 ? 'long'
    : distance >= 135 ? 'mid' : distance >= 112 ? 'short' : 'wedge';
}

export function landX(distance, elevationYards, tanTheta) {
  const H = distance * tanTheta / 4;
  const ratio = 1 - elevationYards / H;
  return ratio < 0 ? -Infinity : distance / 2 * (1 + Math.sqrt(ratio));
}

export function solveD(horizontalYards, elevationYards, tanTheta) {
  if (Math.abs(elevationYards) < 1e-9) return horizontalYards;
  let lo = 0.5;
  let hi = horizontalYards + 6 * Math.abs(elevationYards) + 100;
  for (let i = 0; i < 20 && landX(hi, elevationYards, tanTheta) < horizontalYards; i++) hi *= 2;
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    if (landX(mid, elevationYards, tanTheta) < horizontalYards) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function temperatureAdj(distance, temperatureC, baseTemperatureC = 30) {
  if (temperatureC === null || temperatureC === undefined || temperatureC === '') return 0;
  return 0.33 * Math.min(1, distance / 130) * (Number(baseTemperatureC) - Number(temperatureC));
}

const blank = value => value === '' || value === null || value === undefined;

/** Wind direction is where the wind comes FROM, clockwise from north in degrees. */
export function windComponents(windMs, windRelation = 'cross', windDirection = null, shotHeading = null) {
  const w = blank(windMs) ? 0 : Number(windMs);
  const measured = !blank(windDirection) && !blank(shotHeading);
  if (!Number.isFinite(w) || w < 0 || !['head', 'tail', 'cross'].includes(windRelation)
    || (!blank(windDirection) && !Number.isFinite(Number(windDirection)))
    || (!blank(shotHeading) && !Number.isFinite(Number(shotHeading)))) {
    throw new RangeError('風速・風向・打つ向きの入力を確認してください');
  }
  if (measured) {
    const d = ((Number(windDirection) - Number(shotHeading)) % 360) * Math.PI / 180;
    const cleanZero = value => Math.abs(value) < 1e-10 ? 0 : value;
    return { headwind: cleanZero(w * Math.cos(d)), crosswind: cleanZero(w * Math.sin(d)), measured };
  }
  return {
    headwind: windRelation === 'head' ? w : windRelation === 'tail' && w > 0 ? -w : 0,
    // A manually selected crosswind has known strength but no left/right bearing.
    crosswind: windRelation === 'cross' ? w : 0,
    measured,
  };
}

export function signedWindAdj(distance, headwind) {
  return distance * (headwind >= 0 ? 0.01 : 0.005) * 2.237 * headwind;
}

export function windAdj(distance, windMs, windRelation = 'cross') {
  return signedWindAdj(distance, windComponents(windMs, windRelation).headwind);
}

export function clubBracket(distance, clubs = DEFAULT_CLUBS) {
  const available = validClubs(clubs);
  return {
    below: available.find(c => c.carry <= distance) || null,
    above: [...available].reverse().find(c => c.carry >= distance) || null,
  };
}

/**
 * lineYards: straight line / slope percent (not yard difference); positive = uphill.
 * curveMode: 'arc' (default) or 'simple'; fixedClub: name or null.
 * windDirection and shotHeading: optional compass degrees; both enable vector mode.
 */
export function calculateShot({
  lineYards, gradePercent = 0, temperatureC = null, windMs = null,
  windRelation = 'cross', windDirection = null, shotHeading = null,
  baseTemperatureC = 30, clubs = DEFAULT_CLUBS,
  curveMode = 'arc', fixedClub = null,
}) {
  const L = Number(lineYards);
  const p = Number(gradePercent);
  const Tb = Number(baseTemperatureC);
  const temperature = temperatureC === '' || temperatureC === null || temperatureC === undefined
    ? null : Number(temperatureC);
  const wind = windMs === '' || windMs === null || windMs === undefined ? 0 : Number(windMs);
  if (!(L > 0 && L <= 600) || !Number.isFinite(p) || Math.abs(p) > 99 || !Number.isFinite(Tb)
    || (temperature !== null && !Number.isFinite(temperature)) || !Number.isFinite(wind) || wind < 0
    || !['head', 'tail', 'cross'].includes(windRelation) || !['arc', 'simple'].includes(curveMode)) {
    throw new RangeError('距離・高低差・気温・風速の入力を確認してください');
  }
  const components = windComponents(wind, windRelation, windDirection, shotHeading);
  const g = p / 100;
  const k = 1 / Math.sqrt(1 + g * g);
  const dh = L * k;
  const h = L * g * k;
  let De;
  if (curveMode === 'simple') {
    De = dh + h;
  } else if (fixedClub) {
    const club = validClubs(clubs).find(c => c.name === fixedClub);
    if (!club) throw new RangeError('固定した番手のキャリーを設定してください');
    De = solveD(dh, h, Math.tan(ANGLES[club.type] * Math.PI / 180));
  } else {
    const cat0 = category(dh + h, clubs);
    De = solveD(dh, h, Math.tan(ANGLES[cat0] * Math.PI / 180));
    const cat1 = category(De, clubs);
    if (cat1 !== cat0) De = solveD(dh, h, Math.tan(ANGLES[cat1] * Math.PI / 180));
  }
  const a = De + temperatureAdj(De, temperature, Tb);
  const result = Math.round(a + signedWindAdj(a, components.headwind));
  const flatA = L + temperatureAdj(L, temperature, Tb);
  const flatD = flatA + signedWindAdj(flatA, components.headwind);
  return {
    distance: result,
    windComponents: components,
    breakdown: { elevation: Math.round(De) - L, temperature: Math.round(a) - Math.round(De), wind: result - Math.round(a) },
    flatClub: nearest(flatD, clubs),
    actualClub: nearest(result, clubs),
    bracket: clubBracket(result, clubs),
    highElevationWarning: Math.abs(h) > 0.35 * dh,
    details: { dh, h, De, adjustedTemperature: a, flatDistance: flatD },
  };
}
