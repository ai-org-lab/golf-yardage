import test from 'node:test';
import assert from 'node:assert/strict';
import { readShotHeading } from '../lib/compass.mjs';

function mockTarget({ permission, secure = true, api = true } = {}) {
  const listeners = new Map();
  return {
    isSecureContext: secure,
    DeviceOrientationEvent: api ? (permission ? { requestPermission: permission } : {}) : undefined,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, data) { for (const listener of [...(listeners.get(type) || [])]) listener(data); },
    listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
  };
}
const listening = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('Safari: requests permission synchronously on first tap; north (0°) is valid', async () => {
  let requests = 0;
  const target = mockTarget({ permission: () => { requests++; return Promise.resolve('granted'); } });
  const reading = readShotHeading({ target });
  assert.equal(requests, 1, 'requestPermission must stay in the tap call stack');
  await listening();
  assert.equal(target.listenerCount(), 2);
  target.emit('deviceorientation', { webkitCompassHeading: 0, alpha: 123, absolute: false });
  assert.equal(await reading, 0);
  assert.equal(target.listenerCount(), 0);
});

test('Safari: permission is reused; each tap takes a new sample and then stops', async () => {
  let requests = 0;
  const target = mockTarget({ permission: () => { requests++; return 'granted'; } });
  const first = readShotHeading({ target });
  await listening();
  target.emit('deviceorientation', { webkitCompassHeading: 45 });
  assert.equal(await first, 45);
  target.emit('deviceorientation', { webkitCompassHeading: 90 });
  const second = readShotHeading({ target });
  await listening();
  target.emit('deviceorientation', { webkitCompassHeading: 180 });
  assert.equal(await second, 180);
  assert.equal(await first, 45);
  assert.equal(requests, 1);
  assert.equal(target.listenerCount(), 0);
});

test('denied permission leaves no listeners and may be retried', async () => {
  let requests = 0;
  const target = mockTarget({ permission: () => ++requests === 1 ? 'denied' : 'granted' });
  await assert.rejects(readShotHeading({ target }), /許可されていません/);
  assert.equal(target.listenerCount(), 0);
  const reading = readShotHeading({ target });
  await listening();
  target.emit('deviceorientation', { webkitCompassHeading: 360 });
  assert.equal(await reading, 0);
  assert.equal(requests, 2);
});

test('synchronous and asynchronous permission failures reject without listening', async () => {
  for (const permission of [() => { throw new Error('blocked'); }, () => Promise.reject(new Error('blocked'))]) {
    const target = mockTarget({ permission });
    await assert.rejects(readShotHeading({ target }), /利用許可を確認できません/);
    assert.equal(target.listenerCount(), 0);
  }
});

test('missing API and insecure origin keep manual fallback available', async () => {
  let requests = 0;
  const target = mockTarget({ secure: false, permission: () => { requests++; return 'granted'; } });
  await assert.rejects(readShotHeading({ target }), /HTTPS/);
  assert.equal(requests, 0);
  await assert.rejects(readShotHeading({ target: mockTarget({ api: false }) }), /この端末/);
});

test('absolute alpha converts counterclockwise orientation to clockwise bearing', async () => {
  const target = mockTarget();
  const reading = readShotHeading({ target });
  await listening();
  target.emit('deviceorientation', { alpha: 90, absolute: true });
  assert.equal(await reading, 270);
  assert.equal(target.listenerCount(), 0);
});

test('deviceorientationabsolute can supply a bearing even without absolute flag', async () => {
  const target = mockTarget();
  const reading = readShotHeading({ target });
  await listening();
  target.emit('deviceorientationabsolute', { alpha: 360 });
  assert.equal(await reading, 0);
});

test('relative alpha and unavailable samples are never treated as north', async () => {
  const target = mockTarget();
  const reading = readShotHeading({ target, timeoutMs: 20 });
  const rejection = assert.rejects(reading, /読み取れませんでした/);
  await listening();
  for (const event of [
    { alpha: 0, absolute: false }, { alpha: null, absolute: true },
    { alpha: NaN, absolute: true }, { webkitCompassHeading: -1 },
    { webkitCompassHeading: Infinity }, { webkitCompassHeading: 90, webkitCompassAccuracy: -1 },
  ]) target.emit('deviceorientation', event);
  await rejection;
  assert.equal(target.listenerCount(), 0);
});

test('invalid samples can be followed by a valid compass sample', async () => {
  const target = mockTarget();
  const reading = readShotHeading({ target });
  await listening();
  target.emit('deviceorientation', { webkitCompassHeading: null, alpha: null, absolute: true });
  assert.equal(target.listenerCount(), 2);
  target.emit('deviceorientation', { webkitCompassHeading: 315, webkitCompassAccuracy: 5 });
  assert.equal(await reading, 315);
});

test('missing sensor events time out and remove both listeners', async () => {
  const target = mockTarget();
  await assert.rejects(readShotHeading({ target, timeoutMs: 10 }), /読み取れませんでした/);
  assert.equal(target.listenerCount(), 0);
});

test('invalid timeout is rejected before requesting permission', async () => {
  let requests = 0;
  const target = mockTarget({ permission: () => { requests++; return 'granted'; } });
  await assert.rejects(readShotHeading({ target, timeoutMs: 0 }), RangeError);
  assert.equal(requests, 0);
});
