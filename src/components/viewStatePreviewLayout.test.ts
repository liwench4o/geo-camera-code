import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import { getViewStatePreviewLayout } from './viewStatePreviewLayout';
import type { ViewStatePreviewProps } from './ViewStatePreview';
import type { CameraView } from '../interfaces';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

function testBothFramesFitWindow() {
  for (const available of [
    { width: 1280, height: 720 },
    { width: 1024, height: 600 },
    { width: 375, height: 667 },
  ]) {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 900, height: 1200 },
      { width: 2200, height: 350 },
    ]) {
      const layout = getViewStatePreviewLayout(viewport, available);
      assert(layout.modalWidth <= available.width - 32 + 1e-9, 'both frames and dialog padding must fit horizontally');
      assert(
        layout.previewHeight <= available.height - 192 + 1e-9,
        'frames must leave space for title, actions, and footer',
      );
      assertClose(
        layout.previewWidth / layout.previewHeight,
        viewport.width / viewport.height,
        'exact original aspect',
      );
      assertClose(layout.previewWidth * 2 + layout.previewGap, layout.contentWidth, 'both frames are equally sized');
      assertClose(layout.previewWidth, viewport.width * layout.scale, 'full projection scales to visible width');
      assertClose(layout.previewHeight, viewport.height * layout.scale, 'full projection scales to visible height');
      assert(
        layout.viewport.width === viewport.width && layout.viewport.height === viewport.height,
        'render at original planning dimensions',
      );
    }
  }
}

function testResizeAndInvalidFallback() {
  const viewport = { width: 1600, height: 900 };
  const large = getViewStatePreviewLayout(viewport, { width: 1920, height: 1080 });
  const small = getViewStatePreviewLayout(viewport, { width: 1280, height: 720 });
  assert(small.scale < large.scale, 'window resize changes display size without altering the planning viewport');
  const fallback = getViewStatePreviewLayout({ width: 0, height: Number.NaN }, { width: -1, height: Infinity });
  assert(Number.isFinite(fallback.scale) && fallback.scale > 0, 'invalid dimensions use finite positive defaults');
  assert(fallback.modalWidth <= 1248, 'default layout fits a normal desktop window');
}

interface ElementNode {
  type: unknown;
  props: { children?: unknown; [key: string]: unknown };
}

function findElement(value: unknown, type: string): ElementNode | undefined {
  if (Array.isArray(value)) return value.map((child) => findElement(child, type)).find(Boolean);
  if (!value || typeof value !== 'object' || !('props' in value)) return undefined;
  const element = value as ElementNode;
  return element.type === type ? element : findElement(element.props.children, type);
}

/** Exercise the actual preview component while replacing only UI/WebGL boundaries. */
function loadPreview(): (props: ViewStatePreviewProps) => ElementNode {
  const output = ts.transpileModule(readFileSync('src/components/ViewStatePreview.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleValue: { exports: { default?: (props: ViewStatePreviewProps) => ElementNode } } = { exports: {} };
  const localRequire = (id: string): unknown => {
    if (id === 'antd')
      return { Button: 'Button', Card: 'Card', Space: 'Space', Tooltip: 'Tooltip', Typography: { Text: 'Text' } };
    if (id === '@ant-design/icons') return { ReloadOutlined: 'Reload', SaveOutlined: 'Save' };
    if (id === '@deck.gl/react') return { DeckGL: 'DeckGL' };
    if (id === 'react-map-gl/maplibre') return { Map: 'Map' };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const execute = runInThisContext(`(function(require, module, exports) {\n${output}\n})`) as (
    ...args: unknown[]
  ) => void;
  execute(localRequire, moduleValue, moduleValue.exports);
  assert(moduleValue.exports.default, 'preview component exports its real implementation');
  return moduleValue.exports.default;
}

function testSemanticCameraAndPixelGeometrySurvivePreview() {
  const Preview = loadPreview();
  const viewport = { width: 1600, height: 900 };
  const layout = getViewStatePreviewLayout(viewport, { width: 1280, height: 720 });
  for (const zoom of [-2, 10, 24]) {
    const view: CameraView = { longitude: 114.14, latitude: 22.39, zoom, pitch: 35, bearing: 375 };
    let edited: unknown;
    const onViewStateChange = (event: { viewState: unknown }) => {
      edited = event.viewState;
    };
    const element = Preview({
      id: 'test',
      title: 'Initial State',
      layers: [],
      effects: [],
      cameraConstraints: { minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 85 },
      viewState: view,
      viewportSize: viewport,
      displayScale: layout.scale,
      canSave: true,
      onViewStateChange,
      onReset: () => undefined,
    });
    const deck = findElement(element, 'DeckGL');
    assert(deck, 'preview contains the real Deck boundary');
    assert(
      deck.props.width === viewport.width && deck.props.height === viewport.height,
      'Deck projects original dimensions',
    );
    const rendered = deck.props.viewState as CameraView;
    assert(
      rendered.zoom === zoom && rendered.bearing === 375,
      'preview must not alter semantic zoom or signed bearing',
    );
    assert(rendered.minZoom === -2 && rendered.maxZoom === 24, 'legal zoom boundaries remain unchanged');
    const wrapper = findElement(element, 'div');
    const style = wrapper?.props.style as Record<string, unknown>;
    assert(
      style.width === viewport.width && style.height === viewport.height,
      'world geometry and pixel glyphs share the full viewport',
    );
    assert(style.transform === `scale(${layout.scale})`, 'CSS scales map and pixel glyphs together');
    const update = { ...view, longitude: 115, zoom: zoom === 24 ? 23.5 : zoom + 0.5 };
    (deck.props.onViewStateChange as typeof onViewStateChange)({ viewState: update });
    assert(edited === update, 'controller edits return directly to authored camera coordinates without a zoom offset');
  }
}

testBothFramesFitWindow();
testResizeAndInvalidFallback();
testSemanticCameraAndPixelGeometrySurvivePreview();
