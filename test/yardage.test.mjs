import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLUBS, nearest, category, landX, solveD,
  temperatureAdj, windAdj, windComponents, signedWindAdj, calculateShot,
} from '../lib/yardage.mjs';

const cases = [
  { n: 1, L: 150, p: 7, T: null, wind: null, relation: 'cross', mode: 'arc', want: 161, flat: '8I', actual: '7I' },
  { n: 2, L: 150, p: 7, T: 8, wind: null, relation: 'cross', mode: 'arc', want: 168, flat: '7I', actual: '6I' },
  { n: 3, L: 150, p: 7, T: 8, wind: 4, relation: 'head', mode: 'arc', want: 183, flat: '6I', actual: '5I' },
  { n: 4, L: 150, p: 7, T: 8, wind: 4, relation: 'tail', mode: 'arc', want: 161, flat: '8I', actual: '7I' },
  { n: 5, L: 172, p: -5, T: null, wind: null, relation: 'cross', mode: 'arc', want: 164, flat: '6I', actual: '6I' },
  { n: 6, L: 100, p: 0, T: 8, wind: null, relation: 'cross', mode: 'arc', want: 106 },
  { n: 7, L: 60, p: 12, T: null, wind: null, relation: 'cross', mode: 'arc', want: 66 },
  { n: 8, L: 230, p: -12, T: null, wind: null, relation: 'cross', mode: 'arc', want: 202 },
  { n: 9, L: 200, p: 10, T: 5, wind: 3, relation: 'head', mode: 'arc', want: 252 },
  { n: 10, L: 150, p: 7, T: null, wind: null, relation: 'cross', mode: 'simple', want: 160 },
  { n: 11, L: 120, p: -9, T: 15, wind: 2, relation: 'tail', mode: 'simple', want: 110 },
  { n: 12, L: 150, p: 7, T: 8, wind: 4, direction: 0, heading: 0, want: 183 },
  { n: 13, L: 150, p: 7, T: 8, wind: 4, direction: 0, heading: 180, want: 161 },
  { n: 14, L: 150, p: 7, T: 8, wind: 4, direction: 0, heading: 90, want: 168, crosswind: -4 },
  { n: 15, L: 150, p: 7, T: 8, wind: 4, direction: 0, heading: 45, want: 179 },
  { n: 16, L: 150, p: 7, T: 8, wind: 4, direction: 315, heading: 90, want: 163 },
  { n: 17, L: 180, p: -6, T: 10, wind: 5, direction: 200, heading: 20, want: 166 },
];

for (const c of cases) {
  test(`C-015 受入試験 ${c.n}: ${c.want} yd`, () => {
    const result = calculateShot({
      lineYards: c.L, gradePercent: c.p, temperatureC: c.T,
      windMs: c.wind, windRelation: c.relation, curveMode: c.mode,
      windDirection: c.direction, shotHeading: c.heading,
      clubs: DEFAULT_CLUBS, baseTemperatureC: 30,
    });
    assert.equal(result.distance, c.want);
    assert.ok(Number.isInteger(result.distance));
    if (c.crosswind !== undefined) assert.equal(result.windComponents.crosswind, c.crosswind);
    if (c.flat) assert.equal(result.flatClub.name, c.flat);
    if (c.actual) assert.equal(result.actualClub.name, c.actual);
    assert.equal(result.breakdown.elevation + result.breakdown.temperature + result.breakdown.wind + c.L, result.distance);
  });
}

test('nearest: ties favour longer club; missing clubs use fallback category', () => {
  assert.equal(nearest(151.5).name, '7I'); // 158 vs 145 => 7I
  assert.equal(nearest(151.5, [{ name: 'A', carry: 160, type: 'mid' }, { name: 'B', carry: 143, type: 'short' }]).name, 'A');
  assert.equal(nearest(151.5, [{ name: 'A', carry: 160, type: 'mid' }, { name: 'B', carry: 143, type: 'short' }]).carry, 160);
  assert.equal(nearest(150, []), null);
  assert.equal(category(185, []), 'wood');
  assert.equal(category(160, []), 'long');
  assert.equal(category(135, []), 'mid');
  assert.equal(category(112, []), 'short');
  assert.equal(category(111, []), 'wedge');
});

test('wind vectors: left/right, wrapped degrees, manual fallback, and no crosswind distance adjustment', () => {
  assert.deepEqual(windComponents(4, 'cross', 0, 90), { headwind: 0, crosswind: -4, measured: true });
  assert.deepEqual(windComponents(4, 'cross', 90, 0), { headwind: 0, crosswind: 4, measured: true });
  assert.deepEqual(windComponents(4, 'cross', 360, 450), windComponents(4, 'cross', 0, 90));
  assert.deepEqual(windComponents(4, 'head', null, 0), { headwind: 4, crosswind: 0, measured: false });
  assert.deepEqual(windComponents(4, 'tail', 0, ''), { headwind: -4, crosswind: 0, measured: false });
  assert.deepEqual(windComponents(4, 'cross'), { headwind: 0, crosswind: 4, measured: false });
  for (const wind of ['', null, undefined, 0]) {
    assert.deepEqual(windComponents(wind, 'cross', 315, 90), { headwind: 0, crosswind: 0, measured: true });
  }
  const calm = calculateShot({ lineYards: 150, gradePercent: 7, temperatureC: 8 });
  for (const heading of [90, 270]) {
    const cross = calculateShot({ lineYards: 150, gradePercent: 7, temperatureC: 8,
      windMs: 4, windDirection: 0, shotHeading: heading });
    assert.equal(cross.distance, calm.distance);
    assert.equal(cross.flatClub.name, calm.flatClub.name);
    assert.equal(cross.breakdown.wind, 0);
  }
  assert.equal(signedWindAdj(160, 4), windAdj(160, 4, 'head'));
  assert.equal(signedWindAdj(160, -4), windAdj(160, 4, 'tail'));
});

test('invalid measured wind values are rejected', () => {
  for (const options of [{ windDirection: NaN }, { shotHeading: Infinity }, { windDirection: 'north' }]) {
    assert.throws(() => calculateShot({ lineYards: 150, windMs: 4, ...options }), RangeError);
  }
  assert.throws(() => windComponents(-1), RangeError);
});

test('flat elevation, fixed club and huge elevation warning', () => {
  const flat = calculateShot({ lineYards: 150 });
  assert.equal(flat.distance, 150);
  assert.equal(flat.breakdown.elevation, 0);
  assert.equal(calculateShot({ lineYards: 150, gradePercent: 7, fixedClub: '7I' }).distance, 161);
  assert.equal(calculateShot({ lineYards: 150, gradePercent: 36 }).highElevationWarning, true);
  assert.equal(landX(100, 100, 1), -Infinity);
  assert.equal(solveD(100, 0, 1), 100);
});

test('blank temp/wind causes no adjustment; wind and input validation', () => {
  assert.equal(temperatureAdj(150, null, 30), 0);
  assert.equal(temperatureAdj(150, '', 30), 0);
  assert.equal(windAdj(160, '', 'head'), 0);
  assert.equal(windAdj(160, 4, 'cross'), 0);
  assert.ok(windAdj(160, 4, 'tail') < 0);
  assert.throws(() => calculateShot({ lineYards: 0 }), RangeError);
  assert.throws(() => calculateShot({ lineYards: 150, gradePercent: 100 }), RangeError);
  assert.throws(() => calculateShot({ lineYards: 150, windMs: -4 }), RangeError);
});
