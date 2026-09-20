import { OwnedDeck } from './owned-deck';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Minimal device/loop boundaries exercise teardown ordering and the
// asynchronous initialization race in Node without creating a GL context.
function renderer(options: { connected?: boolean; external?: boolean; pending?: boolean } = {}) {
  const events: string[] = [];
  const canvas = { isConnected: options.connected ?? false };
  const device = {
    type: 'webgl',
    isLost: false,
    canvasContext: { canvas, destroy: () => events.push('canvas-destroy') },
    destroy: () => events.push('device-destroy'),
    loseDevice: () => {
      events.push('context-lost');
      device.isLost = true;
      return true;
    },
  };
  let initialize: ((value: typeof device) => void) | undefined;
  const pending = options.pending
    ? new Promise<typeof device>((resolve) => {
        initialize = resolve;
      })
    : device;
  const instance = Object.assign(Object.create(OwnedDeck.prototype) as OwnedDeck, {
    canvas,
    props: { canvas, device: options.external ? device : undefined },
    device: options.pending ? null : device,
    animationLoop: {
      props: { device: pending },
      stop: () => events.push('loop-stop'),
      destroy: () => events.push('loop-destroy'),
    },
    layerManager: { finalize: () => events.push('layers-finalized') },
    effectManager: { finalize: () => events.push('effects-finalized') },
  });
  return { instance, device, canvas, events, initialize: () => initialize?.(device) };
}

async function run() {
  const ready = renderer();
  ready.instance.finalize();
  assert(ready.device.isLost, 'Unmount must explicitly release the owned context rather than waiting for GC.');
  for (const event of ['layers-finalized', 'effects-finalized', 'device-destroy', 'context-lost']) {
    assert(ready.events.filter((value) => value === event).length === 1, `${event} must occur exactly once.`);
  }
  for (const event of ['layers-finalized', 'effects-finalized']) {
    assert(
      ready.events.indexOf(event) < ready.events.indexOf('device-destroy'),
      'Finalize GPU resources before destroying their device.',
    );
  }
  assert(
    ready.events.indexOf('device-destroy') < ready.events.indexOf('context-lost'),
    'Destroy the device before losing its context.',
  );
  assert(ready.events.includes('canvas-destroy'), 'Release the canvas resize observers with the owned device.');
  ready.instance.finalize();
  assert(
    ready.events.filter((event) => event === 'context-lost').length === 1,
    'Repeated cleanup must not release a context twice.',
  );

  const live = renderer({ connected: true });
  live.instance.finalize();
  assert(!live.device.isLost, 'React StrictMode can finalize and re-create Deck against the same live canvas.');
  assert(!live.events.includes('canvas-destroy'), 'StrictMode must preserve observers for the reused live device.');

  const external = renderer({ external: true });
  external.instance.finalize();
  assert(!external.device.isLost, 'An externally owned device must not be released by this renderer.');

  const pending = renderer({ pending: true });
  pending.instance.finalize();
  assert(!pending.device.isLost, 'A pending device cannot be released before creation finishes.');
  pending.initialize();
  await Promise.resolve();
  await Promise.resolve();
  assert(pending.device.isLost, 'Unmount before initialization must still release the eventual owned context.');

  const reattached = renderer({ pending: true });
  reattached.instance.finalize();
  reattached.canvas.isConnected = true;
  reattached.initialize();
  await Promise.resolve();
  await Promise.resolve();
  assert(!reattached.device.isLost, 'A late device cleanup must recheck whether the canvas is now being used.');

  console.log('Owned Deck teardown releases owned contexts after finalization, including pending devices.');
}

void run();
