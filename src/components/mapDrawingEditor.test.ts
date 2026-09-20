import assert from 'node:assert/strict';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WebMercatorViewport } from '@deck.gl/core';
import Editor, { type MapDrawingFeature } from './MapDrawingEditor';

// Exercise the real editor handlers without mounting a GPU map.
const viewState = { longitude: -1.4, latitude: 52.2, zoom: 6.6, pitch: 40, bearing: -27 };
const viewportSize = { width: 800, height: 500 };
const viewport = new WebMercatorViewport({ ...viewState, ...viewportSize });
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const oldWindow = globalThis.window;
globalThis.window = {
  requestAnimationFrame(callback: FrameRequestCallback) {
    frames.set(++frameId, callback);
    return frameId;
  },
  cancelAnimationFrame(id: number) {
    frames.delete(id);
  },
} as unknown as Window & typeof globalThis;

function eventAt(x: number, y: number, detail = 1) {
  // A scaled viewport catches CSS-scale and card-offset projection mistakes.
  return {
    clientX: 100 + x / 2,
    clientY: 60 + y / 2,
    detail,
    button: 0,
    currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 60, width: 400, height: 250 }) },
    preventDefault() {},
    stopPropagation() {},
  } as unknown as React.PointerEvent<SVGSVGElement>;
}

try {
  const completed: MapDrawingFeature[] = [];
  const editor = new Editor({
    viewState,
    viewportSize,
    onFeatureDrawn: (f) => {
      if (f) completed.push(f);
    },
  });
  let updates = 0;
  editor.setState = ((patch: object) => {
    updates++;
    editor.state = { ...editor.state, ...patch };
  }) as typeof editor.setState;
  const click = (x: number, y: number, detail = 1) => editor.render().props.onClick!(eventAt(x, y, detail));
  const move = (x: number, y: number) => editor.render().props.onPointerMove!(eventAt(x, y));
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };

  click(250, 180);
  assert(!renderToStaticMarkup(editor.render()).includes('data-drawing-fill'), 'one vertex has no area');
  click(400, 180, 2); // Fast clicks at different positions must still add vertices.
  click(250, 180); // Cannot close a two-vertex path or add a duplicate start.
  assert.equal(completed.length, 0);
  click(400, 300);
  let markup = renderToStaticMarkup(editor.render());
  assert(markup.includes('data-drawing-fill="true"'), 'three vertices show the provisional selection area');
  assert(markup.includes('<polyline'), 'the outline stays open until explicitly completed');
  assert.equal((markup.match(/data-drawing-vertex=/g) ?? []).length, 3);
  assert.equal(completed.length, 0, 'a third vertex must not select a region');
  click(400, 300, 2);
  assert.equal(completed.length, 0, 'double clicking away from the start must not close');

  const beforeHover = updates;
  for (let i = 0; i < 100; i++) move(300 + i, 320);
  assert.equal(frames.size, 1, 'coalesce pointer movement into one animation frame');
  assert.equal(updates, beforeHover, 'pointer events must not synchronously render');
  flush();
  assert.equal(updates, beforeHover + 1);
  markup = renderToStaticMarkup(editor.render());
  assert(markup.includes('data-drawing-preview="true"'), 'the last vertex follows the pointer');
  assert.equal(completed.length, 0, 'preview changes must not update the parent selection');
  editor.render().props.onPointerLeave!(eventAt(900, 600));
  assert(!renderToStaticMarkup(editor.render()).includes('data-drawing-preview="true"'));

  click(255, 185);
  assert.equal(completed.length, 1, 'clicking near the start closes once');
  const ring = completed[0].geometry.coordinates[0];
  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], ring[3]);
  const first = viewport.unproject([250, 180]);
  assert(Math.abs(ring[0][0] - first[0]) < 1e-9);
  assert(Math.abs(ring[0][1] - first[1]) < 1e-9);
  assert(
    ring.every((coordinate) => coordinate.length === 2),
    'saved regions remain two-dimensional',
  );
  click(255, 185);
  assert.equal(completed.length, 1, 'completion is protected against repeated events');
  editor.componentWillUnmount();

  const pendingEditor = new Editor({ viewState, viewportSize, onFeatureDrawn() {} });
  pendingEditor.setState = ((patch: object) => {
    pendingEditor.state = { ...pendingEditor.state, ...patch };
  }) as typeof pendingEditor.setState;
  pendingEditor.render().props.onClick!(eventAt(250, 180));
  pendingEditor.render().props.onPointerMove!(eventAt(300, 180));
  assert.equal(frames.size, 1);
  pendingEditor.componentWillUnmount();
  assert.equal(frames.size, 0, 'canceling drawing removes pending preview updates');

  for (const pitch of [0, 60]) {
    const groundView = { ...viewState, pitch, bearing: 35 };
    const groundViewport = new WebMercatorViewport({ ...groundView, ...viewportSize });
    const groundEditor = new Editor({ viewState: groundView, viewportSize, onFeatureDrawn() {} });
    groundEditor.setState = ((patch: object) => {
      groundEditor.state = { ...groundEditor.state, ...patch };
    }) as typeof groundEditor.setState;
    const pixels = [
      [270, 270],
      [430, 270],
      [430, 370],
    ];
    for (const [x, y] of pixels) groundEditor.render().props.onClick!(eventAt(x, y));
    const groundMarkup = renderToStaticMarkup(groundEditor.render());
    assert(groundMarkup.includes('data-drawing-fill="true"'));
    for (let i = 0; i < pixels.length; i++) {
      const ground = groundViewport.unproject(pixels[i], { targetZ: 0 });
      const actual = groundEditor.state.coordinates[i];
      assert(Math.abs(actual[0] - ground[0]) < 1e-9);
      assert(Math.abs(actual[1] - ground[1]) < 1e-9);
      const projected = groundViewport.project([...actual, 0]);
      assert(Math.hypot(projected[0] - pixels[i][0], projected[1] - pixels[i][1]) < 1e-6);
      if (pitch > 0) {
        const elevated = groundViewport.unproject(pixels[i], { targetZ: 3000 });
        assert(Math.abs(actual[1] - elevated[1]) > 1e-4, '3D selection uses the footprint, not column tops');
      }
    }
    const beforePreview = groundMarkup.match(/<polygon[^>]+points="([^"]+)"/)?.[1];
    groundEditor.render().props.onPointerMove!(eventAt(300, 390));
    flush();
    assert.notEqual(
      renderToStaticMarkup(groundEditor.render()).match(/<polygon[^>]+points="([^"]+)"/)?.[1],
      beforePreview,
      'the filled range follows the open preview segment',
    );
    groundEditor.componentWillUnmount();
  }
  const steepEditor = new Editor({ viewState: { ...viewState, pitch: 85 }, viewportSize, onFeatureDrawn() {} });
  steepEditor.setState = ((patch: object) => {
    steepEditor.state = { ...steepEditor.state, ...patch };
  }) as typeof steepEditor.setState;
  steepEditor.render().props.onClick!(eventAt(400, 0));
  assert.equal(steepEditor.state.coordinates.length, 0, 'sky pixels cannot select a ground region behind the camera');
  steepEditor.render().props.onClick!(eventAt(400, 400));
  assert.equal(steepEditor.state.coordinates.length, 1, 'visible ground is still selectable at steep pitch');
  steepEditor.componentWillUnmount();
  console.log('Polygon drawing interaction and frame batching passed.');
} finally {
  globalThis.window = oldWindow;
}
