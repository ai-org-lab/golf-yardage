/** One-shot compass acquisition. Pass a window-like target for hardware-free tests. */
const permissions = new WeakMap();
const normalize = degrees => ((degrees % 360) + 360) % 360;

function compassHeading(event, isAbsoluteEvent) {
  // Safari's compass heading is relative to north; alpha can be relative to an
  // arbitrary starting position and must never be substituted without absolute.
  if (typeof event.webkitCompassHeading === 'number'
    && Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0
    && !(typeof event.webkitCompassAccuracy === 'number' && event.webkitCompassAccuracy < 0)) {
    return normalize(event.webkitCompassHeading);
  }
  if ((isAbsoluteEvent || event.absolute === true)
    && typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
    return normalize(360 - event.alpha);
  }
  return null;
}

function permissionFor(target, orientation) {
  if (typeof orientation.requestPermission !== 'function') return Promise.resolve();
  const saved = permissions.get(target);
  if (saved) return saved;
  let permission;
  try {
    // Keep this call in the original button handler's synchronous call stack.
    permission = orientation.requestPermission();
  } catch {
    return Promise.reject(new Error('方位の利用許可を確認できませんでした。向かい・追い・横を選べます。'));
  }
  const pending = Promise.resolve(permission).then(result => {
    if (result !== 'granted') throw new Error('方位の利用が許可されていません。向かい・追い・横を選べます。');
  }, () => {
    throw new Error('方位の利用許可を確認できませんでした。向かい・追い・横を選べます。');
  });
  permissions.set(target, pending);
  // Retry after a denial/error if the browser's permission setting changes.
  pending.catch(() => permissions.delete(target));
  return pending;
}

/**
 * Call directly from a user tap. Resolves the next valid north-referenced sample
 * as a bearing in degrees [0, 360), then stops listening. Hold the phone flat,
 * screen facing up, with its top edge towards the flag until the reading ends.
 */
export function readShotHeading({ target = globalThis.window, timeoutMs = 6000 } = {}) {
  if (!target?.isSecureContext) {
    return Promise.reject(new Error('方位の測定にはHTTPSが必要です。向かい・追い・横を選べます。'));
  }
  const orientation = target.DeviceOrientationEvent;
  if (!orientation || typeof target.addEventListener !== 'function'
    || typeof target.removeEventListener !== 'function') {
    return Promise.reject(new Error('この端末では方位を使えません。向かい・追い・横を選べます。'));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError('方位の待ち時間が不正です。'));
  }
  return permissionFor(target, orientation).then(() => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener('deviceorientation', onOrientation);
      target.removeEventListener('deviceorientationabsolute', onAbsolute);
    };
    const accept = (event, absolute) => {
      const heading = compassHeading(event, absolute);
      if (heading === null) return;
      cleanup();
      resolve(heading);
    };
    const onOrientation = event => accept(event, false);
    const onAbsolute = event => accept(event, true);
    target.addEventListener('deviceorientation', onOrientation);
    target.addEventListener('deviceorientationabsolute', onAbsolute);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('方位を読み取れませんでした。向かい・追い・横を選べます。'));
    }, timeoutMs);
  }));
}
