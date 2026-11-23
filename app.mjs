import { DEFAULT_CLUBS, validClubs, calculateShot, windComponents } from './lib/yardage.mjs';
import { jstParts, addDays, forecastRows, selectForecastIndex, parseForecast, loadForecast } from './lib/weather.mjs';
import { readShotHeading } from './lib/compass.mjs';

const SETTINGS_KEY = 'golf-yardage-v1-settings';
const WEATHER_KEY = 'golf-yardage-v1-weather';
const SEARCH_KEY = 'golf-yardage-v1-nominatim-cache';
const SEARCH_LAST_KEY = 'golf-yardage-v1-last-search-at';
const TODAY = jstParts();
const MAX_DATE = addDays(TODAY.date, 16);
const HEADING_LIFETIME_MS = 3 * 60_000;
const byId = id => document.getElementById(id);

function safeParse(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { notify('保存領域が使えません。Safariのプライベートブラウズ設定等を確認してください。'); return false; }
}
function cleanCourse(course) {
  if (!course || typeof course !== 'object') return null;
  const latitude = Number(course.latitude);
  const longitude = Number(course.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof course.name !== 'string' || !course.name.trim()) return null;
  return {
    id: typeof course.id === 'string' && /^[\w-]{1,95}$/.test(course.id) ? course.id : randomId(),
    name: course.name.trim().slice(0, 100), latitude, longitude,
  };
}
function randomId() { return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function normalizeSettings(value) {
  const template = {
    version: 1, courses: [], selectedCourseId: null,
    roundDate: TODAY.date, roundTime: TODAY.time, baseTemperatureC: 30,
    clubs: DEFAULT_CLUBS.map(c => ({ ...c })), curveMode: 'arc', fixedClub: null,
  };
  if (!value || typeof value !== 'object' || value.version !== 1) return template;
  const courses = Array.isArray(value.courses) ? value.courses.slice(0, 20).map(cleanCourse).filter(Boolean) : [];
  const byName = new Map((Array.isArray(value.clubs) ? value.clubs : []).map(c => [c?.name, c]));
  const clubs = DEFAULT_CLUBS.map(original => {
    const candidate = byName.get(original.name);
    if (!candidate || (candidate.carry !== null && candidate.carry !== ''
      && (!Number.isFinite(Number(candidate.carry)) || Number(candidate.carry) < 1 || Number(candidate.carry) > 400))) return { ...original };
    return { ...original, carry: candidate.carry === '' || candidate.carry === null ? null : Number(candidate.carry), estimated: Boolean(candidate.estimated) };
  });
  const temp = Number(value.baseTemperatureC);
  const date = typeof value.roundDate === 'string' && value.roundDate >= TODAY.date && value.roundDate <= MAX_DATE ? value.roundDate : TODAY.date;
  const time = typeof value.roundTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.roundTime) ? value.roundTime : TODAY.time;
  return {
    ...template, courses,
    selectedCourseId: courses.some(c => c.id === value.selectedCourseId) ? value.selectedCourseId : (courses[0]?.id ?? null),
    roundDate: date, roundTime: time,
    baseTemperatureC: Number.isFinite(temp) && temp >= -60 && temp <= 70 ? temp : 30,
    clubs, curveMode: value.curveMode === 'simple' ? 'simple' : 'arc',
    fixedClub: clubs.some(c => c.name === value.fixedClub && c.carry !== null) ? value.fixedClub : null,
  };
}
const state = {
  settings: normalizeSettings(safeParse(SETTINGS_KEY, null)),
  weatherCache: safeParse(WEATHER_KEY, {}),
  forecast: null, fetchedAt: null, forecastSource: 'none',
  manualWeatherIndex: null, selectedWeatherIndex: -1, appliedWeatherKey: null,
  windRelation: 'cross', envTemp: null, envWind: null, tempSource: 'unset', windSource: 'unset',
  envWindDirection: null, shotHeading: null, headingMeasuredAt: null, headingRequestSerial: 0,
  headingMessage: '未測定：向かい・追い・横を選べます。',
  requestSerial: 0, activeTab: 'shot', slopeNegative: false,
};
if (!state.weatherCache || Array.isArray(state.weatherCache) || typeof state.weatherCache !== 'object') state.weatherCache = {};
let toastTimeout;
let headingTimeout;
function notify(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 4200);
}
function persist() { store(SETTINGS_KEY, state.settings); }
function currentCourse() { return state.settings.courses.find(c => c.id === state.settings.selectedCourseId) || null; }
function niceTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function signYards(amount) { return `${amount > 0 ? '+' : ''}${amount} yd`; }
function statusCourse() {
  const c = currentCourse();
  const weather = state.forecast ? (state.forecastSource === 'cached' ? '・保存予報' : '・予報取得済') : '';
  byId('shot-weather-summary').textContent = c ? `${c.name}${weather}` : '予報未設定';
}
function setTab(which) {
  state.activeTab = which;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === which;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.tab-panel')) section.hidden = section.id !== `panel-${which}`;
  if (which === 'shot') renderShot();
  if (which === 'chart') renderReference();
  if (which === 'round') renderRound();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function updateSlopeButtons() {
  const negative = state.slopeNegative;
  byId('slope-up').classList.toggle('active', !negative);
  byId('slope-down').classList.toggle('active', negative);
  byId('slope-up').setAttribute('aria-pressed', String(!negative));
  byId('slope-down').setAttribute('aria-pressed', String(negative));
}
function setSlope(negative) {
  state.slopeNegative = negative;
  updateSlopeButtons(); renderShot();
}
function updateSources() {
  for (const [labelId, source] of [['temp-source', state.tempSource], ['wind-source', state.windSource]]) {
    const element = byId(labelId);
    element.textContent = source === 'auto' ? '自動' : source === 'manual' ? '手入力' : '未取得';
    element.className = `source-tag ${source}`;
  }
}
function hasMeasuredWind() {
  return state.shotHeading !== null && state.envWindDirection !== null;
}
function clearMeasuredHeading(message = '未測定：向かい・追い・横を選べます。') {
  clearTimeout(headingTimeout);
  state.shotHeading = null;
  state.headingMeasuredAt = null;
  state.headingMessage = message;
}
function expireHeading(now = Date.now()) {
  if (state.headingMeasuredAt === null) return false;
  const age = now - state.headingMeasuredAt;
  if (age >= 0 && age < HEADING_LIFETIME_MS) return false;
  clearMeasuredHeading('未測定：測定から3分たちました。向きを測り直してください。');
  return true;
}
function scheduleHeadingUpdate() {
  clearTimeout(headingTimeout);
  if (state.headingMeasuredAt === null) return;
  const age = Math.max(0, Date.now() - state.headingMeasuredAt);
  const delay = Math.min(1000 - age % 1000, HEADING_LIFETIME_MS - age);
  headingTimeout = setTimeout(refreshHeading, Math.max(1, delay));
}
function refreshHeading() {
  if (expireHeading()) {
    renderShot();
    if (state.activeTab === 'chart') renderReference();
  } else {
    renderHeadingStatus();
  }
  scheduleHeadingUpdate();
}
function describeWind(components) {
  const { headwind, crosswind, measured } = components;
  const front = `${headwind < 0 ? '追い' : '向かい'} ${Math.abs(headwind).toFixed(1)}m/s`;
  const side = measured && Math.abs(crosswind) >= 0.05 ? (crosswind < 0 ? '左から' : '右から') : '横';
  return `${front}・${side} ${Math.abs(crosswind).toFixed(1)}m/s`;
}
function renderHeadingStatus() {
  const measured = hasMeasuredWind();
  const age = state.headingMeasuredAt === null ? ''
    : `・${Math.floor(Math.max(0, Date.now() - state.headingMeasuredAt) / 1000)}秒前に測定`;
  byId('measure-heading').setAttribute('aria-pressed', String(measured));
  byId('heading-status').textContent = state.shotHeading === null ? state.headingMessage
    : `打つ向き ${Math.round(state.shotHeading) % 360}°${age}${measured ? '（自動）' : '：予報の風向がありません。向かい・追い・横を選んでください。'}`;
}
function renderWind() {
  expireHeading();
  renderHeadingStatus();
  try {
    byId('result-wind-components').textContent = describeWind(windComponents(
      state.envWind, state.windRelation, state.envWindDirection, state.shotHeading));
  } catch {
    byId('result-wind-components').textContent = '風速の入力を確認してください';
  }
}
async function measureHeading() {
  const serial = ++state.headingRequestSerial;
  const button = byId('measure-heading');
  // Invoke directly in the tap handler so Safari can present its permission prompt.
  const reading = readShotHeading();
  button.disabled = true;
  clearMeasuredHeading('方位を測定中…');
  renderShot();
  try {
    const heading = await reading;
    if (serial !== state.headingRequestSerial) return;
    state.shotHeading = heading;
    state.headingMeasuredAt = Date.now();
    scheduleHeadingUpdate();
  } catch (error) {
    if (serial !== state.headingRequestSerial) return;
    state.headingMessage = error.message;
  } finally {
    button.disabled = false;
    renderShot();
  }
}
function adjustWind(delta) {
  const current = Number(byId('shot-wind').value);
  const next = Math.max(0, Math.round(((Number.isFinite(current) ? current : 0) + delta) * 1e6) / 1e6);
  state.envWind = next;
  state.windSource = 'manual';
  byId('shot-wind').value = String(next);
  renderShot();
}
function renderShot() {
  statusCourse(); updateSources(); renderWind();
  for (const button of document.querySelectorAll('[data-wind]')) {
    const on = !hasMeasuredWind() && button.dataset.wind === state.windRelation;
    button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
  }
  const L = byId('shot-distance').value;
  const magnitude = byId('shot-slope').value;
  const p = magnitude === '' ? '' : Math.abs(Number(magnitude)) * (state.slopeNegative ? -1 : 1);
  const distance = byId('result-distance');
  const club = byId('result-club');
  const bracket = byId('result-bracket');
  const warning = byId('shot-warning');
  if (L === '' || p === '') {
    distance.textContent = '—'; club.textContent = '入力待ち'; bracket.textContent = '直線距離を入力してください';
    for (const id of ['elevation', 'temperature', 'wind']) byId(`breakdown-${id}`).textContent = '—';
    warning.hidden = true; return;
  }
  try {
    const result = calculateShot({
      lineYards: L, gradePercent: p, temperatureC: state.envTemp, windMs: state.envWind,
      windRelation: state.windRelation, clubs: state.settings.clubs,
      windDirection: state.envWindDirection, shotHeading: state.shotHeading,
      baseTemperatureC: state.settings.baseTemperatureC, curveMode: state.settings.curveMode,
      fixedClub: state.settings.fixedClub,
    });
    distance.textContent = String(result.distance);
    club.textContent = result.flatClub && result.actualClub
      ? `平ら ${result.flatClub.name} → ${result.actualClub.name}` : 'キャリー未設定';
    const low = result.bracket.below; const high = result.bracket.above;
    bracket.textContent = low && high ? `前後のキャリー：${low.name} ${low.carry} / ${high.name} ${high.carry} yd`
      : low ? `${low.name} ${low.carry} yd 以上の距離` : high ? `${high.name} ${high.carry} yd 以下の距離` : 'マイ飛距離を登録';
    byId('breakdown-elevation').textContent = signYards(result.breakdown.elevation);
    byId('breakdown-temperature').textContent = signYards(result.breakdown.temperature);
    byId('breakdown-wind').textContent = signYards(result.breakdown.wind);
    warning.hidden = !result.highElevationWarning;
    warning.textContent = result.highElevationWarning ? '高低差がかなり大きいので大まかな目安です。' : '';
  } catch (error) {
    distance.textContent = '—'; club.textContent = '入力を確認'; bracket.textContent = error.message;
    for (const id of ['elevation', 'temperature', 'wind']) byId(`breakdown-${id}`).textContent = '—';
    warning.hidden = true;
  }
}
function renderClubSelector() {
  const select = byId('fixed-club');
  select.replaceChildren(new Option('自動で選ぶ', ''));
  for (const club of validClubs(state.settings.clubs)) select.add(new Option(`${club.name} (${club.carry}yd)`, club.name));
  select.value = state.settings.fixedClub || '';
  byId('curve-mode').value = state.settings.curveMode;
}

function weatherFromCache(course) {
  const saved = course ? state.weatherCache[course.id] : null;
  if (!saved || saved.latitude !== course.latitude || saved.longitude !== course.longitude || !saved.data || !saved.fetchedAt) return null;
  try { parseForecast(saved.data); return saved; } catch { return null; }
}
function showWeatherFromCache() {
  const course = currentCourse();
  const cache = weatherFromCache(course);
  state.forecast = cache?.data ?? null;
  state.fetchedAt = cache?.fetchedAt ?? null;
  state.forecastSource = cache ? 'cached' : 'none';
  state.appliedWeatherKey = null;
  renderWeather();
}
async function ensureForecast(force = false) {
  const course = currentCourse();
  if (!course) { renderWeather(); return; }
  const cache = weatherFromCache(course);
  if (!force && cache && Date.now() - new Date(cache.fetchedAt).getTime() < 10 * 60_000) return;
  if (!navigator.onLine) {
    byId('forecast-state').textContent = cache ? 'オフライン：前回の予報を表示中' : 'オフライン：保存済みの予報がありません';
    renderWeather(); return;
  }
  const request = ++state.requestSerial;
  byId('forecast-state').textContent = 'Open-Meteoから予報を取得中…';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    let data;
    try { data = await loadForecast(course.latitude, course.longitude, { signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (request !== state.requestSerial || currentCourse()?.id !== course.id) return;
    state.forecast = data;
    state.fetchedAt = new Date().toISOString();
    state.forecastSource = 'live'; state.appliedWeatherKey = null;
    state.weatherCache[course.id] = { latitude: course.latitude, longitude: course.longitude, fetchedAt: state.fetchedAt, data };
    // Keep a bounded number of cached rounds to avoid localStorage quota errors.
    const keys = Object.keys(state.weatherCache).sort((a, b) =>
      new Date(state.weatherCache[b]?.fetchedAt || 0) - new Date(state.weatherCache[a]?.fetchedAt || 0));
    for (const key of keys.slice(4)) delete state.weatherCache[key];
    store(WEATHER_KEY, state.weatherCache);
    renderWeather();
  } catch (error) {
    if (request !== state.requestSerial) return;
    state.forecastSource = state.forecast ? 'cached' : 'none';
    byId('forecast-state').textContent = state.forecast
      ? `取得失敗（${error.name === 'AbortError' ? '時間切れ' : error.message}）。保存済み予報を表示中。`
      : `予報取得失敗（${error.name === 'AbortError' ? '時間切れ' : error.message}）。通信と地点を確認してください。`;
    renderWeather(true);
  }
}
function renderWeather(preserveStatus = false) {
  const table = byId('weather-table-body');
  table.replaceChildren();
  state.envWindDirection = null;
  const course = currentCourse();
  let rows = [];
  if (course && state.forecast) {
    try { rows = forecastRows(state.forecast, state.settings.roundDate, state.settings.roundTime); }
    catch { rows = []; }
  }
  if (!rows.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5;
    td.textContent = course ? '予報がありません。更新するか手動で気温・風速を入力してください。' : 'ゴルフ場を選んでください';
    tr.append(td); table.append(tr); state.selectedWeatherIndex = -1;
  } else {
    const selected = selectForecastIndex(rows, state.settings.roundDate, state.settings.roundTime, new Date(), state.manualWeatherIndex);
    state.selectedWeatherIndex = selected;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; const tr = document.createElement('tr');
      tr.dataset.available = String(row.available); tr.setAttribute('aria-selected', String(i === selected));
      const time = row.time.slice(11, 16);
      const values = [
        `${time}${i === selected ? ' ✓' : ''}`,
        row.temperatureC !== null ? `${row.temperatureC} ℃` : '—',
        row.windMs !== null ? `${row.windMs} m/s` : '—',
        row.gustMs !== null ? `${row.gustMs} m/s` : '—',
        row.direction?.name || '—',
      ];
      for (let j = 0; j < values.length; j++) {
        const td = document.createElement('td'); td.textContent = values[j];
        if (j === 4 && row.direction) {
          const arrow = document.createElement('span');
          const bearingIndex = Math.round((((row.windDegrees % 360) + 360) % 360) / 22.5) % 16;
          arrow.className = `wind-arrow wind-arrow-${bearingIndex}`;
          arrow.textContent = '↑';
          arrow.setAttribute('aria-hidden', 'true'); td.append(arrow);
        }
        tr.append(td);
      }
      if (row.available) {
        tr.tabIndex = 0; tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label', `${time}の予報を計算に使用`);
        const choose = () => { state.manualWeatherIndex = i; state.appliedWeatherKey = null; renderWeather(); setTab('shot'); };
        tr.addEventListener('click', choose);
        tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
      }
      table.append(tr);
    }
    if (selected >= 0 && rows[selected]?.available) {
      const row = rows[selected];
      state.envWindDirection = row.windDegrees;
      const nextKey = `${course.id}/${state.fetchedAt}/${row.time}`;
      if (state.appliedWeatherKey !== nextKey) {
        state.appliedWeatherKey = nextKey;
        state.envTemp = row.temperatureC; state.envWind = row.windMs;
        state.tempSource = 'auto'; state.windSource = 'auto';
        byId('shot-temperature').value = String(row.temperatureC);
        byId('shot-wind').value = String(row.windMs);
        renderShot();
      }
      byId('shot-direction').textContent = `予報：${row.direction?.name || '風向不明'} / ${row.time.slice(11, 16)}`;
    } else {
      byId('shot-direction').textContent = 'この時間帯の予報はありません（手入力可）';
    }
  }
  byId('fetched-at').textContent = state.fetchedAt
    ? `最終取得：${niceTime(state.fetchedAt)}（${state.forecastSource === 'cached' ? '端末保存の予報' : '取得済み・端末にも保存'}）` : '予報未取得';
  if (!preserveStatus) {
    byId('forecast-state').textContent = !course ? 'ゴルフ場を登録してください。'
      : !state.forecast ? '予報未取得。通信が必要です。'
      : rows.every(r => !r.available) ? 'この日・時刻の予報は提供されていません。気温・風速を手入力してください。'
      : `計算に使用：${rows[state.selectedWeatherIndex]?.time.slice(11, 16)}の予報（${state.forecastSource === 'cached' ? '保存済み' : '取得済み'}）`;
  }
  statusCourse(); renderShot();
  if (state.activeTab === 'chart') renderReference();
}
function renderCourseSelect() {
  const select = byId('saved-courses');
  select.replaceChildren(new Option('ゴルフ場を選んでください', ''));
  for (const c of state.settings.courses) select.add(new Option(c.name, c.id));
  select.value = state.settings.selectedCourseId || '';
  const course = currentCourse();
  byId('selected-course-coordinates').textContent = course
    ? `緯度 ${course.latitude.toFixed(5)} / 経度 ${course.longitude.toFixed(5)}` : '未登録';
  byId('remove-course').disabled = !course;
}
function renderRound() {
  renderCourseSelect();
  byId('round-date').min = TODAY.date;
  byId('round-date').max = MAX_DATE;
  byId('round-date').value = state.settings.roundDate;
  byId('round-time').value = state.settings.roundTime;
  renderWeather();
}
function switchCourse(id) {
  state.requestSerial++;
  state.settings.selectedCourseId = state.settings.courses.some(c => c.id === id) ? id : null;
  state.manualWeatherIndex = null;
  state.envTemp = null; state.envWind = null;
  state.envWindDirection = null; state.headingRequestSerial++; clearMeasuredHeading();
  state.tempSource = 'unset'; state.windSource = 'unset';
  byId('shot-temperature').value = ''; byId('shot-wind').value = '';
  persist(); showWeatherFromCache(); renderCourseSelect();
  if (currentCourse()) void ensureForecast();
}
function addCourse(raw) {
  const item = cleanCourse(raw);
  if (!item) { notify('ゴルフ場名と正しい緯度・経度を入力してください。'); return; }
  const existing = state.settings.courses.find(c => c.id === item.id
    || (Math.abs(c.latitude - item.latitude) < 0.00001 && Math.abs(c.longitude - item.longitude) < 0.00001));
  if (existing) { switchCourse(existing.id); notify('登録済みのゴルフ場を選びました。'); return; }
  if (state.settings.courses.length >= 20) { notify('登録は20件までです。不要なゴルフ場を削除してください。'); return; }
  state.settings.courses.push(item);
  switchCourse(item.id);
  notify('ゴルフ場を端末に登録しました。');
}
function renderSearchResults(results) {
  const container = byId('search-results'); container.replaceChildren();
  if (!Array.isArray(results) || !results.length) { container.textContent = '候補がありません。別の名前か緯度・経度で登録してください。'; return; }
  for (const result of results.slice(0, 6)) {
    const lat = Number(result.lat), lon = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const button = document.createElement('button'); button.className = 'search-hit'; button.type = 'button';
    button.textContent = String(result.display_name || '名称不明').slice(0, 150);
    const sub = document.createElement('small'); sub.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · タップして登録`;
    button.append(sub);
    button.addEventListener('click', () => {
      const name = String(result.name || result.display_name?.split(',')[0] || 'ゴルフ場').slice(0, 100);
      addCourse({ id: `osm-${String(result.osm_type || 'place')}-${String(result.osm_id || '').replace(/\W/g, '').slice(0, 20)}`, name, latitude: lat, longitude: lon });
      container.replaceChildren();
    });
    container.append(button);
  }
}
async function searchCourses() {
  const query = byId('course-query').value.trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 100) { notify('2文字以上のゴルフ場名を入力してください。'); return; }
  const cache = safeParse(SEARCH_KEY, {});
  if (cache && cache[query] && Date.now() - cache[query].at < 30 * 24 * 3600_000) {
    renderSearchResults(cache[query].results); notify('保存済みの検索結果を表示しました。'); return;
  }
  let last = 0;
  try { last = Number(localStorage.getItem(SEARCH_LAST_KEY) || 0); } catch { /* storage unavailable */ }
  if (Date.now() - last < 1000) { notify('検索は1秒に1回までです。'); return; }
  if (!navigator.onLine) { notify('名前での検索には通信が必要です。'); return; }
  const button = byId('search-course'); button.disabled = true;
  try {
    try { localStorage.setItem(SEARCH_LAST_KEY, String(Date.now())); } catch { /* storage unavailable */ }
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', 'accept-language': 'ja' }).toString();
    // Browser sends the Pages origin as HTTP Referer. Do not disable/referrer-strip it.
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    if (!Array.isArray(results)) throw new TypeError('検索結果の形式が不正です');
    const saved = cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
    saved[query] = { at: Date.now(), results: results.slice(0, 6) };
    const keys = Object.keys(saved).sort((a, b) => saved[b].at - saved[a].at);
    for (const key of keys.slice(12)) delete saved[key];
    store(SEARCH_KEY, saved);
    renderSearchResults(results);
  } catch (error) { notify(`ゴルフ場検索に失敗：${error.message}。手入力も使えます。`); }
  finally { button.disabled = false; }
}
function renderProfile() {
  byId('base-temperature').value = String(state.settings.baseTemperatureC);
  const box = byId('club-rows'); box.replaceChildren();
  for (const club of state.settings.clubs) {
    const row = document.createElement('div'); row.className = 'club-row';
    const name = document.createElement('span'); name.className = 'club-name'; name.textContent = club.name;
    const field = document.createElement('input'); field.type = 'number'; field.inputMode = 'decimal'; field.min = '1'; field.max = '400'; field.step = 'any';
    field.value = club.carry === null ? '' : String(club.carry);
    field.setAttribute('aria-label', `${club.name}のキャリー（yd）`);
    field.addEventListener('change', () => {
      if (field.value !== '' && (!Number.isFinite(Number(field.value)) || Number(field.value) < 1 || Number(field.value) > 400)) {
        notify('キャリーは1〜400ydで入力してください。'); field.value = club.carry ?? ''; return;
      }
      club.carry = field.value === '' ? null : Number(field.value); club.estimated = false;
      if (!club.carry && state.settings.fixedClub === club.name) state.settings.fixedClub = null;
      persist(); renderProfile(); renderClubSelector(); renderShot();
      if (state.activeTab === 'chart') renderReference();
    });
    const type = document.createElement('span'); type.className = 'club-type';
    type.textContent = ({ wood: 'ウッド', long: 'ロング', mid: 'ミドル', short: 'ショート', wedge: 'ウェッジ' })[club.type];
    if (club.estimated && club.carry !== null) {
      const badge = document.createElement('span'); badge.className = 'estimated-badge'; badge.textContent = '推定';
      type.append(document.createElement('br'), badge);
    }
    row.append(name, field, type); box.append(row);
  }
}
function settingsExport() {
  return JSON.stringify({
    ...state.settings,
    exportedAt: new Date().toISOString(),
    // Weather, Nominatim results and precise browser position are not included.
  }, null, 2);
}
function renderReference() {
  if (expireHeading()) renderShot();
  const grades = [-12, -9, -6, -3, 3, 6, 9, 12];
  const head = byId('reference-head'); const body = byId('reference-body');
  head.replaceChildren(); body.replaceChildren();
  const tr = document.createElement('tr');
  for (const label of ['直線', ...grades.map(g => `${g > 0 ? '+' : ''}${g}%`)]) {
    const th = document.createElement('th'); th.textContent = label; tr.append(th);
  }
  head.append(tr);
  const parts = [];
  if (state.envTemp !== null) parts.push(`気温 ${state.envTemp}℃`);
  if (state.envWind !== null) parts.push(`風速 ${state.envWind}m/s`);
  try { parts.push(describeWind(windComponents(state.envWind, state.windRelation, state.envWindDirection, state.shotHeading))); }
  catch { parts.push('風速の入力を確認'); }
  parts.push(state.settings.curveMode === 'arc' ? '球筋補正' : 'シンプル');
  byId('chart-condition').textContent = `現在の補正条件：${parts.join(' / ')}`;
  for (let distance = 60; distance <= 230; distance += 10) {
    const row = document.createElement('tr');
    const label = document.createElement('td'); label.textContent = `${distance} yd`; row.append(label);
    for (const grade of grades) {
      const cell = document.createElement('td'); const button = document.createElement('button'); button.type = 'button';
      try {
        const result = calculateShot({ lineYards: distance, gradePercent: grade,
          temperatureC: state.envTemp, windMs: state.envWind, windRelation: state.windRelation,
          windDirection: state.envWindDirection, shotHeading: state.shotHeading,
          clubs: state.settings.clubs, baseTemperatureC: state.settings.baseTemperatureC,
          curveMode: state.settings.curveMode, fixedClub: state.settings.fixedClub });
        button.textContent = String(result.distance);
      } catch { button.textContent = '—'; button.disabled = true; }
      button.setAttribute('aria-label', `直線${distance}ヤード、高低差${grade}パーセントを入力`);
      button.addEventListener('click', () => {
        byId('shot-distance').value = String(distance); byId('shot-slope').value = String(Math.abs(grade));
        state.slopeNegative = grade < 0; updateSlopeButtons(); renderShot(); setTab('shot');
        byId('shot-distance').focus({ preventScroll: true });
      });
      cell.append(button); row.append(cell);
    }
    body.append(row);
  }
}
function updateConnectivity() {
  const pill = byId('connection-pill');
  const offline = !navigator.onLine;
  pill.textContent = offline ? 'オフライン' : 'オンライン';
  pill.classList.toggle('offline', offline);
}

function bindEvents() {
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => setTab(tab.dataset.tab));
  byId('go-round').addEventListener('click', () => setTab('round'));
  byId('shot-distance').addEventListener('input', renderShot);
  byId('shot-slope').addEventListener('input', () => {
    const input = byId('shot-slope');
    if (input.value.startsWith('-')) {
      state.slopeNegative = true;
      input.value = input.value.slice(1);
    }
    updateSlopeButtons(); renderShot();
  });
  byId('slope-up').addEventListener('click', () => setSlope(false));
  byId('slope-down').addEventListener('click', () => setSlope(true));
  for (const button of document.querySelectorAll('[data-wind]')) button.addEventListener('click', () => {
    state.headingRequestSerial++; clearMeasuredHeading('手動：向かい・追い・横を選択中。');
    state.windRelation = button.dataset.wind; renderShot();
  });
  byId('measure-heading').addEventListener('click', measureHeading);
  byId('wind-decrease').addEventListener('click', () => adjustWind(-1));
  byId('wind-increase').addEventListener('click', () => adjustWind(1));
  for (const [id, valueKey, sourceKey] of [['shot-temperature', 'envTemp', 'tempSource'], ['shot-wind', 'envWind', 'windSource']]) {
    byId(id).addEventListener('input', () => {
      const value = byId(id).value;
      state[valueKey] = value === '' ? null : Number(value);
      state[sourceKey] = 'manual'; renderShot();
    });
  }
  byId('curve-mode').addEventListener('change', () => { state.settings.curveMode = byId('curve-mode').value; persist(); renderShot(); });
  byId('fixed-club').addEventListener('change', () => { state.settings.fixedClub = byId('fixed-club').value || null; persist(); renderShot(); });
  byId('saved-courses').addEventListener('change', () => switchCourse(byId('saved-courses').value));
  byId('remove-course').addEventListener('click', () => {
    const course = currentCourse();
    if (course && window.confirm(`「${course.name}」を削除しますか？`)) {
      state.settings.courses = state.settings.courses.filter(c => c.id !== course.id);
      switchCourse(state.settings.courses[0]?.id || '');
    }
  });
  byId('search-course').addEventListener('click', searchCourses);
  byId('course-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void searchCourses(); } });
  byId('register-manual').addEventListener('click', () => {
    if (byId('manual-lat').value === '' || byId('manual-lon').value === '') {
      notify('緯度と経度を両方入力してください。'); return;
    }
    addCourse({ id: randomId(), name: byId('manual-name').value.trim() || '手入力のゴルフ場',
      latitude: Number(byId('manual-lat').value), longitude: Number(byId('manual-lon').value) });
  });
  byId('use-location').addEventListener('click', () => {
    if (!navigator.geolocation || !window.isSecureContext) { notify('現在地はHTTPS環境でのみ利用できます。'); return; }
    byId('use-location').disabled = true;
    navigator.geolocation.getCurrentPosition(position => {
      byId('use-location').disabled = false;
      byId('manual-lat').value = String(position.coords.latitude);
      byId('manual-lon').value = String(position.coords.longitude);
      addCourse({ id: randomId(), name: byId('manual-name').value.trim() || '現在地のゴルフ場',
        latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, error => { byId('use-location').disabled = false; notify(`位置情報が使えません（${error.message}）。手入力できます。`); },
    { enableHighAccuracy: false, maximumAge: 60_000, timeout: 12000 });
  });
  for (const id of ['round-date', 'round-time']) byId(id).addEventListener('change', () => {
    const date = byId('round-date').value, time = byId('round-time').value;
    if (date < TODAY.date || date > MAX_DATE || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      notify('ラウンド日は今日から16日先まで、時刻は00:00〜23:59で指定してください。'); renderRound(); return;
    }
    state.settings.roundDate = date; state.settings.roundTime = time;
    state.manualWeatherIndex = null; state.appliedWeatherKey = null;
    persist(); renderWeather(); void ensureForecast();
  });
  byId('refresh-weather').addEventListener('click', () => void ensureForecast(true));
  byId('base-temperature').addEventListener('change', () => {
    const value = Number(byId('base-temperature').value);
    if (byId('base-temperature').value === '' || !Number.isFinite(value) || value < -60 || value > 70) {
      notify('基準気温は−60〜70℃で入力してください。'); renderProfile(); return;
    }
    state.settings.baseTemperatureC = value; persist(); renderShot();
  });
  byId('reset-clubs').addEventListener('click', () => {
    if (!window.confirm('マイ飛距離と基準気温を初期値に戻しますか？')) return;
    state.settings.clubs = DEFAULT_CLUBS.map(c => ({ ...c }));
    state.settings.baseTemperatureC = 30; state.settings.fixedClub = null;
    persist(); renderProfile(); renderClubSelector(); renderShot();
  });
  byId('export-settings').addEventListener('click', () => {
    byId('settings-json').value = settingsExport();
    byId('settings-status').textContent = '書き出しました。コピーしてテキストとして保存できます。';
    byId('settings-json').select();
  });
  byId('copy-settings').addEventListener('click', async () => {
    const text = byId('settings-json').value || settingsExport();
    byId('settings-json').value = text;
    try { await navigator.clipboard.writeText(text); byId('settings-status').textContent = '設定をコピーしました。'; }
    catch { byId('settings-json').select(); byId('settings-status').textContent = '自動コピーできませんでした。選択したテキストを手動でコピーしてください。'; }
  });
  byId('import-settings').addEventListener('click', () => {
    const text = byId('settings-json').value;
    if (text.length > 50_000) { notify('読み込める設定は50KBまでです。'); return; }
    let parsed;
    try {
      parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.clubs) || !Array.isArray(parsed.courses)
        || parsed.courses.length > 20 || parsed.courses.some(c => !cleanCourse(c))) throw new Error('形式が不正です');
    } catch { byId('settings-status').textContent = '読み込み失敗：設定JSONの形式を確認してください。'; return; }
    if (!window.confirm('現在のゴルフ場とマイ飛距離の設定を上書きしますか？')) return;
    state.settings = normalizeSettings(parsed);
    state.manualWeatherIndex = null; state.appliedWeatherKey = null;
    state.headingRequestSerial++; clearMeasuredHeading();
    state.envTemp = null; state.envWind = null; state.tempSource = 'unset'; state.windSource = 'unset';
    byId('shot-temperature').value = ''; byId('shot-wind').value = '';
    persist(); renderProfile(); renderClubSelector(); renderCourseSelect(); showWeatherFromCache();
    byId('settings-status').textContent = '設定を読み込みました。';
    if (currentCourse()) void ensureForecast();
  });
  window.addEventListener('online', () => { updateConnectivity(); void ensureForecast(); });
  window.addEventListener('offline', () => { updateConnectivity(); renderWeather(); });
  window.addEventListener('focus', refreshHeading);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshHeading();
      if (state.manualWeatherIndex === null) renderWeather();
    }
  });
  // Forecast row choice follows the current hour when the app remains open.
  setInterval(() => { if (!document.hidden && state.manualWeatherIndex === null && state.forecast) renderWeather(); }, 60_000);
}
function startApp() {
  bindEvents(); updateConnectivity(); renderClubSelector(); renderProfile(); renderRound();
  state.slopeNegative = false; updateSlopeButtons(); renderShot();
  if (currentCourse()) { showWeatherFromCache(); void ensureForecast(); }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // The rest of the app remains usable; the shell may not be available offline.
      console.warn('Service Worker registration failed');
    });
  }
}
startApp();
