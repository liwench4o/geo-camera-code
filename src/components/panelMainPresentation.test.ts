import { getOptionalPanelText, getRuntimeLayerPolicy, getRuntimeStatusText } from './panelMainPresentation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(getOptionalPanelText('') === undefined, 'empty text must not render numeric zero');
assert(getOptionalPanelText('  ') === undefined, 'whitespace-only text must not render');
assert(getOptionalPanelText('Title') === 'Title', 'non-empty text must render unchanged');
assert(getRuntimeLayerPolicy('initial-loading') === 'empty', 'initial load must use empty layers');
assert(getRuntimeLayerPolicy('incompatible-loading') === 'empty', 'dataset switch must clear old layers');
assert(getRuntimeLayerPolicy('refreshing') === 'previous', 'compatible refresh must retain prior layers');
assert(getRuntimeLayerPolicy('ready') === 'current', 'ready state must use current layers');
assert(getRuntimeLayerPolicy('initial-error') === 'empty', 'initial failure must not expose stale layers');
assert(getRuntimeLayerPolicy('refresh-error') === 'previous', 'refresh failure may retain the labeled prior result');
assert(getRuntimeStatusText('initial-loading') === 'Loading map data…', 'initial load must announce progress');
assert(getRuntimeStatusText('refreshing') === 'Updating visualization…', 'refresh must announce progress');
assert(
  getRuntimeStatusText('refresh-error') === 'Showing the previous valid result',
  'refresh failure must identify the stale result',
);
assert(getRuntimeStatusText('ready') === undefined, 'ready state must not retain a status badge');
assert(getRuntimeStatusText('initial-error') === undefined, 'the alert owns initial error messaging');
