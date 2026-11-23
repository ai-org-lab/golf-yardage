/** C-015: forecast parsing & selection. No network inside pure functions. */
export const DIRECTION_NAMES = Object.freeze([
  '北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西',
]);

export function windDirection(degrees) {
  if (!Number.isFinite(Number(degrees)) || degrees === null || degrees === '') return null;
  const normalized = ((Number(degrees) % 360) + 360) % 360;
  return {
    name: `${DIRECTION_NAMES[Math.round(normalized / 22.5) % 16]}の風`,
    // Open-Meteo gives the direction the wind COMES FROM; arrow shows where it GOES.
    arrowDegrees: (normalized + 180) % 360,
  };
}

export function jstParts(date = new Date()) {
  const items = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = key => items.find(item => item.type === key)?.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export function addDays(dateIso, count) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new Error('Invalid date');
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function forecastURL(latitude, longitude) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))
    || latitude === '' || longitude === '' || Number(latitude) < -90 || Number(latitude) > 90
    || Number(longitude) < -180 || Number(longitude) > 180) throw new RangeError('緯度経度が不正です');
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'ms', timezone: 'Asia/Tokyo', forecast_days: '16',
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

export function parseForecast(data) {
  const keys = ['time', 'temperature_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
  if (!data || typeof data !== 'object' || !data.hourly || !Array.isArray(data.hourly.time)
    || keys.some(key => !Array.isArray(data.hourly[key]) || data.hourly[key].length !== data.hourly.time.length)) {
    throw new TypeError('予報の形式が不正です');
  }
  if (data.hourly_units && data.hourly_units.wind_speed_10m !== 'm/s') {
    throw new TypeError('風速の単位が m/s ではありません');
  }
  if (data.timezone && data.timezone !== 'Asia/Tokyo') {
    throw new TypeError('予報の時刻が日本時間ではありません');
  }
  const entries = new Map();
  for (let i = 0; i < data.hourly.time.length; i++) {
    const time = data.hourly.time[i];
    if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(time)) continue;
    const safeNumber = val => val === null || val === undefined || val === ''
      || !Number.isFinite(Number(val)) ? null : Number(val);
    const temperatureC = safeNumber(data.hourly.temperature_2m[i]);
    const windMs = safeNumber(data.hourly.wind_speed_10m[i]);
    const bearing = safeNumber(data.hourly.wind_direction_10m[i]);
    const gustMs = safeNumber(data.hourly.wind_gusts_10m[i]);
    entries.set(time, {
      time, temperatureC, windMs, windDegrees: bearing, gustMs,
      direction: windDirection(bearing),
      available: temperatureC !== null && windMs !== null,
    });
  }
  return entries;
}

export function forecastRows(data, date, startTime) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(startTime)) {
    throw new TypeError('日付とスタート時刻を確認してください');
  }
  const entries = parseForecast(data);
  const base = new Date(`${date}T${startTime.slice(0, 2)}:00:00.000Z`);
  // A five-hour interval starting at 08:20 touches six hourly bins (08 through 13).
  const hourCount = startTime.slice(3) === '00' ? 5 : 6;
  return Array.from({ length: hourCount }, (_, index) => {
    const stamp = new Date(base.getTime() + index * 3600_000).toISOString().slice(0, 16);
    return entries.get(stamp) || {
      time: stamp, temperatureC: null, windMs: null, windDegrees: null,
      gustMs: null, direction: null, available: false,
    };
  });
}

export function selectForecastIndex(rows, date, startTime, now = new Date(), manualIndex = null) {
  if (Number.isInteger(manualIndex) && manualIndex >= 0 && manualIndex < rows.length
    && rows[manualIndex]?.available) return manualIndex;
  const start = `${date}T${startTime}`;
  const current = jstParts(now);
  const jstNow = `${current.date}T${current.time}`;
  const roundEnd = new Date(new Date(`${start}:00Z`).getTime() + 5 * 3600_000).toISOString().slice(0, 16);
  if (jstNow >= start && jstNow < roundEnd) {
    const currentHour = `${current.date}T${current.time.slice(0, 2)}:00`;
    const index = rows.findIndex(row => row.time === currentHour && row.available);
    if (index >= 0) return index;
  }
  return rows.findIndex(row => row.available);
}

/** Fetch is injected for deterministic, completely offline tests. */
export async function loadForecast(latitude, longitude, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(forecastURL(latitude, longitude), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  parseForecast(data); // Reject a wrong unit or malformed payload before it reaches storage.
  return data;
}
