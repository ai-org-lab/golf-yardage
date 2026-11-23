import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  windDirection, forecastURL, parseForecast, forecastRows,
  selectForecastIndex, jstParts, addDays, loadForecast,
} from '../lib/weather.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/open-meteo.json', import.meta.url), 'utf8'));

test('Open-Meteo fetch mock: URL, hourly variables, units and timezone', async () => {
  let count = 0;
  const mockFetch = async (url, options) => {
    count++;
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    assert.equal(parsed.pathname, '/v1/forecast');
    assert.equal(parsed.searchParams.get('hourly'), 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
    assert.equal(parsed.searchParams.get('wind_speed_unit'), 'ms');
    assert.equal(parsed.searchParams.get('timezone'), 'Asia/Tokyo');
    assert.equal(parsed.searchParams.get('forecast_days'), '16');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => fixture };
  };
  const result = await loadForecast(34.7, 135.5, { fetchImpl: mockFetch });
  assert.equal(count, 1);
  assert.equal(result.timezone, 'Asia/Tokyo');
  assert.ok(forecastURL(34.7, 135.5).includes('wind_speed_unit=ms'));
});

test('forecast: five hours from 08:20 spans 08:00–13:00; current 10:40 picks 10:00', () => {
  const rows = forecastRows(fixture, '2026-11-23', '08:20');
  assert.deepEqual(rows.map(row => row.time), ['2026-11-23T08:00','2026-11-23T09:00','2026-11-23T10:00','2026-11-23T11:00','2026-11-23T12:00','2026-11-23T13:00']);
  assert.equal(rows[0].temperatureC, 10);
  assert.equal(rows[0].windMs, 6);
  assert.equal(rows[0].gustMs, 9);
  assert.equal(rows[0].direction.name, '北西の風');
  assert.equal(rows[0].direction.arrowDegrees, 135);
  assert.equal(selectForecastIndex(rows, '2026-11-23', '08:20', new Date('2026-11-23T01:40:00Z')), 2);
  assert.equal(selectForecastIndex(rows, '2026-11-23', '08:20', new Date('2026-11-22T01:40:00Z')), 0);
  assert.equal(selectForecastIndex(rows, '2026-11-23', '08:20', new Date('2026-11-23T01:40:00Z'), 4), 4);
  assert.equal(selectForecastIndex(rows, '2026-11-23', '08:20', new Date('2026-11-23T04:10:00Z')), 5);
});

test('16 points of wind / arrows handle boundary', () => {
  const names = ['北','北北東','北東','東北東','東','東南東','南東','南南東','南','南南西','南西','西南西','西','西北西','北西','北北西'];
  for (let i = 0; i < 16; i++) assert.equal(windDirection(i * 22.5).name, `${names[i]}の風`);
  assert.equal(windDirection(360).name, '北の風');
  assert.equal(windDirection(-45).name, '北西の風');
  assert.equal(windDirection(null), null);
});

test('reject wrong units and missing entries (no fabricated forecast)', () => {
  const bad = structuredClone(fixture);
  bad.hourly_units.wind_speed_10m = 'km/h';
  assert.throws(() => parseForecast(bad), /m\/s/);
  const outOfRange = forecastRows(fixture, '2026-12-09', '08:00');
  assert.equal(outOfRange.length, 5);
  assert.equal(outOfRange.every(x => !x.available), true);
  assert.equal(selectForecastIndex(outOfRange, '2026-12-09', '08:00'), -1);
});

test('JST time has stable date and bounds across UTC', () => {
  assert.deepEqual(jstParts(new Date('2026-11-22T15:37:00Z')), { date: '2026-11-23', time: '00:37' });
  assert.equal(addDays('2026-11-23', 16), '2026-12-09');
});

test('mock fetch non-2xx and malformed body are rejected', async () => {
  await assert.rejects(loadForecast(34.7, 135.5, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
  await assert.rejects(loadForecast(34.7, 135.5, { fetchImpl: async () => ({ ok: true, json: async () => ({ bad: true }) }) }), /形式/);
});
