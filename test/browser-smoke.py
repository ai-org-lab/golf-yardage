"""Optional 390px/offline browser test. External fetches are mocked; no Internet needed.

Run: python3 test/browser-smoke.py
Requires Python playwright and local Chromium; does not download dependencies.
"""
import json
import threading
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "test/fixtures/open-meteo.json").read_text()
NOMINATIM = json.dumps([{"place_id": 101, "osm_type": "way", "osm_id": 7654,
                         "name": "試験ゴルフ場", "display_name": "試験ゴルフ場, 大阪府, 日本",
                         "lat": "34.71", "lon": "135.51"}], ensure_ascii=False)


def dated_forecast():
    """Keep the saved fixture deterministic while making UI dates valid on any day."""
    data = json.loads(FIXTURE)
    first = datetime.fromisoformat(data['hourly']['time'][0]).date()
    today = datetime.now(ZoneInfo('Asia/Tokyo')).date()
    offset = today - first
    data['hourly']['time'] = [
        (datetime.fromisoformat(stamp) + offset).isoformat(timespec='minutes')
        for stamp in data['hourly']['time']
    ]
    return data


COMPASS_MOCK = """(() => {
    window.__compass = { permissionCalls: 0, activations: [], permission: 'granted' };
    class MockDeviceOrientationEvent extends Event {
        constructor(type, values = {}) { super(type); Object.assign(this, values); }
        static requestPermission() {
            __compass.permissionCalls++;
            __compass.activations.push(navigator.userActivation.isActive);
            return Promise.resolve(__compass.permission);
        }
    }
    Object.defineProperty(window, 'DeviceOrientationEvent', {
        value: MockDeviceOrientationEvent, configurable: true,
    });
    window.__emitHeading = heading => window.dispatchEvent(
        new MockDeviceOrientationEvent('deviceorientation', {
            webkitCompassHeading: heading, webkitCompassAccuracy: 5,
        })
    );
})();"""


def assert_wind_vocabulary(page):
    """Visible shot copy, including fallback messages, uses the approved terms."""
    expect(page.locator("[data-wind='head']")).to_have_text('アゲインスト')
    expect(page.locator("[data-wind='tail']")).to_have_text('フォロー')
    expect(page.locator("[data-wind='cross']")).to_have_text('横風')
    shot_text = page.locator('#panel-shot').inner_text()
    assert '向かい' not in shot_text and '追い' not in shot_text
    assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
    for selector in ["[data-wind='head']", "[data-wind='tail']", "[data-wind='cross']"]:
        assert page.locator(selector).evaluate('(button) => button.scrollWidth <= button.clientWidth')


def compass_ui_tests(browser, origin):
    """Real app integration with browser APIs and forecast data fully mocked."""
    data = dated_forecast()
    errors = []

    def set_weather(temperature=8, wind=4, direction=0):
        for key, value in [('temperature_2m', temperature), ('wind_speed_10m', wind),
                           ('wind_direction_10m', direction)]:
            data['hourly'][key] = [value] * len(data['hourly']['time'])

    def new_page(permission='granted', supported=True):
        context = browser.new_context(viewport={'width': 390, 'height': 844},
                                      is_mobile=True, has_touch=True,
                                      locale='ja-JP', timezone_id='Asia/Tokyo')
        context.route('https://**', lambda route: route.abort())
        context.route('https://api.open-meteo.com/**', lambda route: route.fulfill(
            status=200, content_type='application/json', body=json.dumps(data)))
        script = COMPASS_MOCK
        if not supported:
            script += "\nObject.defineProperty(window, 'DeviceOrientationEvent', {value: undefined, configurable: true});"
        context.add_init_script(script)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'{origin}/index.html', wait_until='networkidle')
        if permission != 'granted':
            page.evaluate('(permission) => __compass.permission = permission', permission)
        assert page.evaluate('() => __compass.permissionCalls') == 0
        page.locator("[data-tab='round']").click()
        page.locator('#round-time').fill('08:00')
        page.locator('#round-time').dispatch_event('change')
        page.locator('#manual-name').fill('方位モック試験')
        page.locator('#manual-lat').fill('34.7')
        page.locator('#manual-lon').fill('135.5')
        page.locator('#register-manual').click()
        expect(page.locator('#fetched-at')).to_contain_text('最終取得')
        page.locator('#weather-table-body tr').first.click()
        page.locator('#shot-distance').fill('150')
        page.locator('#shot-slope').fill('7')
        assert_wind_vocabulary(page)
        return context, page

    def refresh(page):
        page.locator("[data-tab='round']").click()
        with page.expect_response('https://api.open-meteo.com/**'):
            page.locator('#refresh-weather').click()
        expect(page.locator('#forecast-state')).to_contain_text('計算に使用')
        page.locator('#weather-table-body tr').first.click()

    def measure(page, heading):
        page.locator('#measure-heading').click()
        page.evaluate('(heading) => __emitHeading(heading)', heading)
        expect(page.locator('#measure-heading')).to_be_enabled()

    set_weather()
    context, page = new_page()
    cases = [
        (12, 150, 7, 8, 4, 0, 0, 183, 'アゲインスト 4.0m/s'),
        (13, 150, 7, 8, 4, 0, 180, 161, 'フォロー 4.0m/s'),
        (14, 150, 7, 8, 4, 0, 90, 168, '左から 4.0m/s'),
        (15, 150, 7, 8, 4, 0, 45, 179, 'アゲインスト 2.8m/s・左から 2.8m/s'),
        (16, 150, 7, 8, 4, 315, 90, 163, 'フォロー 2.8m/s・左から 2.8m/s'),
        (17, 180, -6, 10, 5, 200, 20, 166, 'フォロー 5.0m/s'),
    ]
    for n, line, grade, temperature, wind, direction, heading, want, components in cases:
        set_weather(temperature, wind, direction)
        refresh(page)
        page.locator('#shot-distance').fill(str(line))
        page.locator('#slope-down' if grade < 0 else '#slope-up').click()
        page.locator('#shot-slope').fill(str(abs(grade)))
        measure(page, heading)
        expect(page.locator('#result-distance')).to_have_text(str(want))
        expect(page.locator('#result-wind-components')).to_contain_text(components)
        assert page.evaluate('() => __compass.permissionCalls') == 1
        assert page.evaluate('() => __compass.activations') == [True]
        page.evaluate('() => __emitHeading(123)')
        expect(page.locator('#result-distance')).to_have_text(str(want))
        assert_wind_vocabulary(page)
        print(f'PASS: UI 方位モック受入試験 {n}: {want} yd; {components}')

    # A southeast source gives a follow component and wind from the right.
    set_weather(wind=1.25 ** 0.5, direction=153.434948822922)
    refresh(page)
    page.locator('#shot-distance').fill('150')
    page.locator('#slope-up').click()
    page.locator('#shot-slope').fill('7')
    measure(page, 0)
    expect(page.locator('#result-wind-components')).to_have_text('フォロー 1.0m/s・右から 0.5m/s')
    assert_wind_vocabulary(page)
    page.locator("[data-tab='chart']").click()
    expect(page.locator('#chart-condition')).to_contain_text('フォロー 1.0m/s・右から 0.5m/s')
    expect(page.locator('#chart-condition')).not_to_contain_text('追い')
    page.locator("[data-tab='shot']").click()
    print('PASS: v1.3 風の3ボタンはアゲインスト・フォロー・横風、フォロー1.0m/s・右から0.5m/sも新表記')

    # Measured projection also applies in the reference table and stays consistent.
    set_weather()
    refresh(page)
    page.locator('#shot-distance').fill('150')
    page.locator('#slope-up').click()
    page.locator('#shot-slope').fill('6')
    measure(page, 45)
    shot_distance = page.locator('#result-distance').inner_text()
    page.locator("[data-tab='chart']").click()
    expect(page.locator('#chart-condition')).to_contain_text('アゲインスト 2.8m/s・左から 2.8m/s')
    expect(page.locator('#chart-condition')).not_to_contain_text('向かい')
    cell = page.locator('#reference-body tr').nth(9).locator('button').nth(5)
    expect(cell).to_have_text(shot_distance)
    cell.click()
    expect(page.locator('#result-distance')).to_have_text(shot_distance)

    # +/-1 starts from the automatic decimal value, preserves decimals and marks manual.
    set_weather(wind=4.6)
    refresh(page)
    expect(page.locator('#wind-source')).to_have_text('自動')
    expect(page.locator('#shot-wind')).to_have_value('4.6')
    page.locator('#wind-increase').click()
    expect(page.locator('#shot-wind')).to_have_value('5.6')
    expect(page.locator('#wind-source')).to_have_text('手入力')
    page.locator('#wind-decrease').click()
    expect(page.locator('#shot-wind')).to_have_value('4.6')
    page.locator('#shot-wind').fill('0.4')
    page.locator('#wind-decrease').click()
    expect(page.locator('#shot-wind')).to_have_value('0')
    page.locator('#wind-decrease').click()
    expect(page.locator('#shot-wind')).to_have_value('0')
    page.locator('#wind-increase').click()
    expect(page.locator('#shot-wind')).to_have_value('1')

    # A manual relation chosen during a pending capture wins over its eventual event.
    set_weather()
    refresh(page)
    page.locator('#shot-slope').fill('7')
    page.locator('#measure-heading').click()
    page.locator("[data-wind='head']").click()
    page.evaluate('() => __emitHeading(180)')
    expect(page.locator('#result-distance')).to_have_text('183')
    expect(page.locator("[data-wind='head']")).to_have_attribute('aria-pressed', 'true')
    page.locator("[data-tab='chart']").click()
    expect(page.locator('#chart-condition')).to_contain_text('アゲインスト 4.0m/s')
    expect(page.locator('#chart-condition')).not_to_contain_text('向かい')
    page.locator("[data-tab='shot']").click()
    page.locator("[data-wind='tail']").click()
    expect(page.locator('#result-distance')).to_have_text('161')
    page.locator("[data-tab='chart']").click()
    expect(page.locator('#chart-condition')).to_contain_text('フォロー 4.0m/s')
    expect(page.locator('#chart-condition')).not_to_contain_text('追い')
    page.locator("[data-tab='shot']").click()
    page.locator("[data-wind='cross']").click()
    expect(page.locator('#result-distance')).to_have_text('168')
    print('PASS: v1.3 自動・手動の早見表条件もアゲインスト・フォローで統一')

    # Offline reload must include the newly introduced compass module.
    page.evaluate('() => navigator.serviceWorker.ready.then(() => true)')
    page.reload(wait_until='networkidle')
    assert page.evaluate("() => caches.match('./lib/compass.mjs').then(Boolean)"), 'Compass module missing from offline app shell'
    context.set_offline(True)
    page.reload(wait_until='domcontentloaded')
    expect(page.locator('#connection-pill')).to_have_text('オフライン')
    page.locator('#shot-distance').fill('150')
    page.locator('#shot-slope').fill('7')
    measure(page, 45)
    expect(page.locator('#result-distance')).to_have_text('179')
    expect(page.locator('#result-wind-components')).to_contain_text('左から 2.8m/s')
    assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(ROOT / 'screenshots/iphone-390-wind.png'), full_page=True)
    context.close()

    # Expiry is based on measurement time, independent of input order and edits.
    set_weather()
    expiry_context, expiry = new_page()
    expiry.clock.install()
    expiry.clock.pause_at(datetime.now(ZoneInfo('Asia/Tokyo')) + timedelta(seconds=1))
    measure(expiry, 45)
    expect(expiry.locator('#heading-status')).to_contain_text('0秒前に測定')
    expect(expiry.locator('#result-distance')).to_have_text('179')
    expiry.clock.fast_forward(179000)
    expect(expiry.locator('#heading-status')).to_contain_text('179秒前に測定')
    expect(expiry.locator('#measure-heading')).to_have_attribute('aria-pressed', 'true')
    expect(expiry.locator('#result-distance')).to_have_text('179')
    expiry.clock.fast_forward(1000)
    expect(expiry.locator('#heading-status')).to_contain_text('未測定')
    expect(expiry.locator('#measure-heading')).to_have_attribute('aria-pressed', 'false')
    expect(expiry.locator('#result-distance')).to_have_text('168')
    expect(expiry.locator('#result-wind-components')).to_have_text('アゲインスト 0.0m/s・横 4.0m/s')
    print('PASS: v1.2 方位は179秒まで有効、180秒で未測定に戻り距離・風成分も再計算')

    # Measure before any shot inputs; entering them after 90s must not reset age.
    expiry.locator('#shot-distance').fill('')
    expiry.locator('#shot-slope').fill('')
    measure(expiry, 0)
    expect(expiry.locator('#result-distance')).to_have_text('—')
    expiry.clock.fast_forward(90000)
    expiry.locator('#shot-slope').fill('7')
    expiry.locator('#shot-distance').fill('150')
    expect(expiry.locator('#heading-status')).to_contain_text('90秒前に測定')
    expect(expiry.locator('#result-distance')).to_have_text('183')
    expiry.clock.fast_forward(89000)
    expect(expiry.locator('#measure-heading')).to_have_attribute('aria-pressed', 'true')
    expiry.clock.fast_forward(1000)
    expect(expiry.locator('#heading-status')).to_contain_text('未測定')
    expect(expiry.locator('#result-distance')).to_have_text('168')
    print('PASS: v1.2 入力前の方位測定も同じ180秒で解除、途中の距離・高低差入力は期限を延長しない')

    # A fresh measurement owns its own three minutes, even across the old expiry.
    measure(expiry, 0)
    expiry.clock.fast_forward(120000)
    measure(expiry, 180)
    expect(expiry.locator('#heading-status')).to_contain_text('0秒前に測定')
    expiry.clock.fast_forward(60000)
    expect(expiry.locator('#heading-status')).to_contain_text('60秒前に測定')
    expect(expiry.locator('#result-distance')).to_have_text('161')
    expiry.clock.fast_forward(120000)
    expect(expiry.locator('#heading-status')).to_contain_text('未測定')
    expect(expiry.locator('#result-distance')).to_have_text('168')
    print('PASS: v1.2 測り直しは新しい測定時刻から3分間有効')

    # Simulate a suspended tab: Date moves on while no timer callbacks run.
    measure(expiry, 0)
    expiry.evaluate("() => Object.defineProperty(document, 'hidden', {value: true, configurable: true})")
    measured_at = expiry.evaluate('() => Date.now()')
    expiry.clock.set_system_time(datetime.fromtimestamp((measured_at + 180000) / 1000, ZoneInfo('UTC')))
    expiry.evaluate("""() => {
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(expiry.locator('#heading-status')).to_contain_text('未測定')
    expect(expiry.locator('#result-distance')).to_have_text('168')
    expiry_context.close()
    print('PASS: v1.2 タイマーが止まったタブの復帰時にも期限切れ方位を解除')

    # Denial and missing API retain the original three manual relation buttons.
    for permission, supported in [('denied', True), ('granted', False)]:
        fallback_context, fallback = new_page(permission, supported)
        fallback.locator('#measure-heading').click()
        expect(fallback.locator('#measure-heading')).to_be_enabled()
        assert_wind_vocabulary(fallback)
        fallback.locator("[data-wind='head']").click()
        expect(fallback.locator('#result-distance')).to_have_text('183')
        fallback.locator("[data-wind='tail']").click()
        expect(fallback.locator('#result-distance')).to_have_text('161')
        fallback.locator("[data-wind='cross']").click()
        expect(fallback.locator('#result-distance')).to_have_text('168')
        fallback_context.close()

    # A relative-alpha event cannot silently become a north-referenced heading.
    timeout_context, timeout_page = new_page()
    timeout_page.clock.install()
    timeout_page.locator('#measure-heading').click()
    timeout_page.evaluate("() => dispatchEvent(new DeviceOrientationEvent('deviceorientation', {alpha: 0, absolute: false}))")
    timeout_page.clock.fast_forward(6100)
    expect(timeout_page.locator('#measure-heading')).to_be_enabled()
    assert_wind_vocabulary(timeout_page)
    timeout_page.locator("[data-wind='head']").click()
    expect(timeout_page.locator('#result-distance')).to_have_text('183')
    timeout_context.close()
    assert not errors, errors
    print('PASS: compass permission-on-tap, six heading mocks, one-shot capture, manual fallback/race, decimal wind +/-1, zero clamp, reference projection, offline compass')


def search_and_coordinates_ui_tests(browser, origin):
    """v1.3: Japanese IME, durable search feedback and Maps coordinate paste."""
    errors, requests = [], []
    response = {'status': 200, 'body': NOMINATIM}
    context = browser.new_context(viewport={'width': 390, 'height': 844},
                                  is_mobile=True, has_touch=True,
                                  locale='ja-JP', timezone_id='Asia/Tokyo')
    context.route('https://**', lambda route: route.abort())
    context.route('https://api.open-meteo.com/**', lambda route: route.fulfill(
        status=200, content_type='application/json', body=json.dumps(dated_forecast())))

    def search_mock(route):
        requests.append(route.request.url)
        route.fulfill(status=response['status'], content_type='application/json', body=response['body'])

    context.route('https://nominatim.openstreetmap.org/**', search_mock)
    context.add_init_script("""(() => {
        const originalFetch = window.fetch;
        window.__searchFetches = [];
        window.fetch = (...args) => {
            if (String(args[0]).startsWith('https://nominatim.openstreetmap.org/')) {
                __searchFetches.push(String(args[0]));
            }
            return originalFetch(...args);
        };
    })();""")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(f'{origin}/index.html', wait_until='networkidle')
        page.clock.install()
        page.clock.pause_at(datetime.now(ZoneInfo('Asia/Tokyo')) + timedelta(seconds=1))
        page.locator("[data-tab='round']").click()
        query = page.locator('#course-query')
        results = page.locator('#search-results')
        query.fill('変換確認ゴルフ場')
        for options in [{'isComposing': True, 'keyCode': 13}, {'isComposing': False, 'keyCode': 229}]:
            query.evaluate("""(input, options) => input.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', ...options,
            }))""", options)
            assert page.evaluate('() => __searchFetches.length') == 0
            assert not requests
            expect(results).not_to_contain_text('検索は1秒に1回までです')
        with page.expect_response('https://nominatim.openstreetmap.org/**'):
            query.press('Enter')
        expect(results.locator('.search-hit')).to_have_count(1)
        assert len(requests) == 1
        print('PASS: v1.3 日本語変換中・keyCode229のEnterは検索せず、通常Enterだけ検索')

        # The rate-limit message remains readable after the transient toast ends.
        query.fill('連続検索ゴルフ場')
        page.locator('#search-course').click()
        expect(results).to_contain_text('検索は1秒に1回までです')
        page.clock.fast_forward(5000)
        expect(page.locator('#toast')).to_be_hidden()
        expect(results).to_contain_text('検索は1秒に1回までです')
        assert len(requests) == 1
        with page.expect_response('https://nominatim.openstreetmap.org/**'):
            page.locator('#search-course').click()
        expect(results.locator('.search-hit')).to_have_count(1)
        expect(results).not_to_contain_text('検索は1秒に1回までです')
        print('PASS: v1.3 1秒制限は結果欄に残り、次の成功検索で候補へ更新')

        response.update(status=503, body='{}')
        page.clock.fast_forward(1000)
        query.fill('通信失敗ゴルフ場')
        with page.expect_response('https://nominatim.openstreetmap.org/**'):
            page.locator('#search-course').click()
        expect(results).to_contain_text('失敗')
        expect(results).to_contain_text('503')
        page.clock.fast_forward(5000)
        expect(page.locator('#toast')).to_be_hidden()
        expect(results).to_contain_text('503')
        print('PASS: v1.3 HTTP検索エラーはお知らせ消去後も結果欄で読める')

        context.set_offline(True)
        query.fill('オフライン確認ゴルフ場')
        page.locator('#search-course').click()
        expect(results).to_contain_text('通信')
        page.clock.fast_forward(5000)
        expect(page.locator('#toast')).to_be_hidden()
        expect(results).to_contain_text('通信')
        context.set_offline(False)
        query.fill('あ')
        page.locator('#search-course').click()
        expect(results).to_contain_text('2文字')
        page.clock.fast_forward(5000)
        expect(page.locator('#toast')).to_be_hidden()
        expect(results).to_contain_text('2文字')

        response.update(status=200, body='[]')
        query.fill('候補なしゴルフ場')
        with page.expect_response('https://nominatim.openstreetmap.org/**'):
            page.locator('#search-course').click()
        expect(results).to_contain_text('Google マップで場所を長押しして出る数字を貼ると登録できます')
        print('PASS: v1.3 オフライン・入力エラーも結果欄に残り、候補なしにはGoogleマップの案内')

        # One-line paste keeps the full precision in both fields and saved settings.
        page.locator('#manual-name').fill('Googleマップの座標')
        page.locator('#manual-coordinates').fill('34.5111495, 135.5865954')
        expect(page.locator('#manual-lat')).to_have_value('34.5111495')
        expect(page.locator('#manual-lon')).to_have_value('135.5865954')
        page.locator('#register-manual').click()
        courses = page.evaluate("() => JSON.parse(localStorage.getItem('golf-yardage-v1-settings')).courses")
        assert len(courses) == 1
        assert courses[0]['latitude'] == 34.5111495 and courses[0]['longitude'] == 135.5865954

        # Synthetic clipboard supplies the same text to the existing number input.
        page.locator('#manual-name').fill('緯度欄への貼り付け')
        page.locator('#manual-lat').evaluate("""(input, text) => {
            const clipboard = new DataTransfer();
            clipboard.setData('text/plain', text);
            input.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: clipboard,
            }));
        }""", '35.1234567, 139.7654321')
        expect(page.locator('#manual-lat')).to_have_value('35.1234567')
        expect(page.locator('#manual-lon')).to_have_value('139.7654321')
        page.locator('#register-manual').click()
        courses = page.evaluate("() => JSON.parse(localStorage.getItem('golf-yardage-v1-settings')).courses")
        assert len(courses) == 2
        assert courses[-1]['latitude'] == 35.1234567 and courses[-1]['longitude'] == 139.7654321

        page.locator('#manual-name').fill('南緯・西経の座標')
        page.locator('#manual-coordinates').fill(' -33.8688 , -70.6693 ')
        expect(page.locator('#manual-lat')).to_have_value('-33.8688')
        expect(page.locator('#manual-lon')).to_have_value('-70.6693')
        page.locator('#register-manual').click()
        courses = page.evaluate("() => JSON.parse(localStorage.getItem('golf-yardage-v1-settings')).courses")
        assert len(courses) == 3
        assert courses[-1]['latitude'] == -33.8688 and courses[-1]['longitude'] == -70.6693
        print('PASS: v1.3 1行座標と緯度欄へのカンマ区切り貼り付けで緯度・経度を分割し、精度と負号を維持して登録')

        page.locator('#manual-name').fill('不正な範囲の座標')
        page.locator('#manual-coordinates').fill('91, 181')
        page.locator('#register-manual').click()
        courses = page.evaluate("() => JSON.parse(localStorage.getItem('golf-yardage-v1-settings')).courses")
        assert len(courses) == 3, 'Invalid coordinate pair registered stale previous values'
        assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
        print('PASS: v1.3 不正な座標は前の値で誤登録しない、390pxの横はみ出しなし')
        assert not errors, errors
    finally:
        context.close()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        return


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors, counts = [], {"weather": 0, "search": 0}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/chromium",
                                                 args=["--no-sandbox"])
            context = browser.new_context(viewport={"width": 390, "height": 844},
                                          device_scale_factor=2, is_mobile=True, has_touch=True,
                                          locale="ja-JP", timezone_id="Asia/Tokyo")

            def weather_mock(route):
                counts["weather"] += 1
                route.fulfill(status=200, content_type="application/json", body=json.dumps(dated_forecast()))
            def search_mock(route):
                counts["search"] += 1
                route.fulfill(status=200, content_type="application/json", body=NOMINATIM)

            context.route("https://**", lambda route: route.abort())  # no real Internet
            context.route("https://api.open-meteo.com/**", weather_mock)
            context.route("https://nominatim.openstreetmap.org/**", search_mock)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/index.html", wait_until="networkidle")
            assert page.locator("#result-distance").inner_text() == "—"
            assert page.locator("#connection-pill").inner_text() == "オンライン"
            page.locator("[data-tab='round']").click()
            page.locator("#round-time").fill("08:20")
            page.locator("#round-time").dispatch_event("change")
            page.locator("#manual-name").fill("テストラウンド")
            page.locator("#manual-lat").fill("34.7")
            page.locator("#manual-lon").fill("135.5")
            page.locator("#register-manual").click()
            page.wait_for_function("() => document.querySelector('#fetched-at')?.textContent.includes('最終取得')", timeout=10000)
            assert counts["weather"] == 1, counts
            assert page.locator("#weather-table-body tr").count() == 6
            assert page.locator("#weather-table-body tr[aria-selected='true']").count() == 1

            # Manual row select overrides before/while-round auto selection.
            page.locator("#weather-table-body tr").nth(2).click()
            assert not page.locator("#panel-shot").is_hidden()
            assert page.locator("#temp-source").inner_text() == "自動"
            assert page.locator("#wind-source").inner_text() == "自動"
            page.locator("#shot-distance").fill("150")
            page.locator("#shot-slope").fill("7")
            assert page.locator("#result-distance").inner_text() != "—"
            assert page.locator("#result-club").inner_text().startswith("平ら")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), '390px horizontal overflow'
            for element_id in ("shot-distance", "shot-slope", "result-distance"):
                box = page.locator(f"#{element_id}").bounding_box()
                assert box and box['y'] + box['height'] <= 844, (element_id, box)
            (ROOT / 'screenshots').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / 'screenshots/iphone-390-shot.png'), full_page=False)

            # iPhone's unsigned keypad: direction stays separate from magnitude.
            page.locator("#slope-down").click()
            page.locator("#shot-slope").fill("5")
            expect(page.locator("#slope-down")).to_have_attribute("aria-pressed", "true")
            expect(page.locator("#shot-slope")).to_have_value("5")
            assert page.locator("#breakdown-elevation").inner_text().startswith('-')
            page.locator("#shot-slope").fill("3")
            expect(page.locator("#slope-down")).to_have_attribute("aria-pressed", "true")
            expect(page.locator("#shot-slope")).to_have_value("3")
            assert page.locator("#breakdown-elevation").inner_text().startswith('-')
            page.locator("#shot-slope").fill("")
            page.locator("#shot-slope").fill("0")
            page.locator("#shot-slope").fill("3")
            expect(page.locator("#slope-down")).to_have_attribute("aria-pressed", "true")
            assert page.locator("#breakdown-elevation").inner_text().startswith('-')
            print('PASS: v1.2 −下り→5→3、空欄・0を経由しても下りを保持、欄は数字のみ')

            # Explicit negative input switches to down, while display stays unsigned.
            page.locator("#slope-up").click()
            page.locator("#shot-slope").fill("-5")
            expect(page.locator("#slope-down")).to_have_attribute("aria-pressed", "true")
            expect(page.locator("#shot-slope")).to_have_value("5")
            assert page.locator("#breakdown-elevation").inner_text().startswith('-')
            page.locator("#slope-up").click()
            expect(page.locator("#shot-slope")).to_have_value("5")
            page.locator("#shot-slope").fill("3")
            expect(page.locator("#slope-up")).to_have_attribute("aria-pressed", "true")
            assert page.locator("#breakdown-elevation").inner_text().startswith('+')
            print('PASS: v1.2 −5の直接入力は下り、＋選択後の再入力は上りを保持')

            # Saved profile, export, and import must round-trip.
            page.locator("[data-tab='profile']").click()
            carry = page.locator("input[aria-label='6Iのキャリー（yd）']")
            carry.fill("172")
            carry.dispatch_event("change")
            page.locator("#export-settings").click()
            exported = page.locator("#settings-json").input_value()
            assert next(c for c in json.loads(exported)['clubs'] if c['name'] == '6I')['carry'] == 172
            page.locator("input[aria-label='6Iのキャリー（yd）']").fill("180")
            page.locator("input[aria-label='6Iのキャリー（yd）']").dispatch_event("change")
            page.locator("#settings-json").fill(exported)
            page.once("dialog", lambda dialog: dialog.accept())
            page.locator("#import-settings").click()
            assert page.locator("input[aria-label='6Iのキャリー（yd）']").input_value() == '172'

            # Nominatim must not be invoked until the search button is pressed.
            page.locator("[data-tab='round']").click()
            page.locator("#course-query").fill("試験ゴルフ場")
            assert counts['search'] == 0
            page.locator("#search-course").click()
            page.locator(".search-hit").first.wait_for()
            assert counts['search'] == 1
            page.locator(".search-hit").first.click()
            assert page.locator("#saved-courses option").count() == 3
            page.screenshot(path=str(ROOT / 'screenshots/iphone-390-round.png'), full_page=True)

            # Reference table has 18 distance rows × 8 slopes and returns to shot screen.
            page.locator("[data-tab='chart']").click()
            assert page.locator("#reference-body tr").count() == 18
            assert page.locator("#reference-body tr").first.locator('button').count() == 8
            page.locator("#reference-body tr").first.locator('button').first.click()
            assert page.locator("#shot-distance").input_value() == '60'
            expect(page.locator("#shot-slope")).to_have_value('12')
            expect(page.locator("#slope-down")).to_have_attribute("aria-pressed", "true")

            # SW must cache the app shell; saved weather and math survive offline reload.
            page.evaluate("() => navigator.serviceWorker.ready.then(() => true)")
            page.reload(wait_until="networkidle")
            assert page.evaluate('Boolean(navigator.serviceWorker.controller)'), 'Service Worker not controlling the page'
            context.set_offline(True)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("() => document.querySelector('#connection-pill')?.textContent === 'オフライン'", timeout=10000)
            page.locator("[data-tab='round']").click()
            assert '最終取得' in page.locator("#fetched-at").inner_text()
            assert page.locator("#weather-table-body tr").count() == 6
            page.locator("[data-tab='shot']").click()
            page.locator("#shot-distance").fill("150")
            page.locator("#shot-slope").fill("7")
            assert page.locator("#result-distance").inner_text() != '—'
            assert not errors, errors
            context.close()
            compass_ui_tests(browser, f'http://127.0.0.1:{server.server_port}')
            search_and_coordinates_ui_tests(browser, f'http://127.0.0.1:{server.server_port}')
            browser.close()
        print(f"PASS: 390px viewport, math UI, saved clubs, JSON import/export, search-on-click, 5-hour forecast, offline service worker, cached weather; mocks={counts}")
        print('Screenshots: screenshots/iphone-390-shot.png, screenshots/iphone-390-round.png')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
