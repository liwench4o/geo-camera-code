import type { ViewportSize } from '../camera/types';
import { getDefaultViewportSize } from '../camera/viewport';

const PREVIEW_GAP_PX = 8;
const MODAL_HORIZONTAL_BODY_PADDING_PX = 48;
const WINDOW_MARGIN_PX = 32;
// Title, reset action, footer, body padding, and space outside the dialog.
const MODAL_VERTICAL_CHROME_PX = 192;
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 720 };

export interface ViewStatePreviewLayout {
  viewport: ViewportSize;
  scale: number;
  previewWidth: number;
  previewHeight: number;
  previewGap: number;
  contentWidth: number;
  modalWidth: number;
}

function getValidSize(size: ViewportSize | undefined, fallback: ViewportSize): ViewportSize {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    return fallback;
  }
  return size;
}

/** Keep the projection and pixel glyph sizes intact; scale the entire rendered canvas for display. */
export function getViewStatePreviewLayout(
  viewportSize?: ViewportSize,
  windowSize?: ViewportSize,
): ViewStatePreviewLayout {
  const viewport = getValidSize(viewportSize, getDefaultViewportSize());
  const available = getValidSize(windowSize, DEFAULT_WINDOW_SIZE);
  const availableWidth = Math.max(
    1,
    (available.width - WINDOW_MARGIN_PX - MODAL_HORIZONTAL_BODY_PADDING_PX - PREVIEW_GAP_PX) / 2,
  );
  const availableHeight = Math.max(1, available.height - MODAL_VERTICAL_CHROME_PX);
  const scale = Math.min(availableWidth / viewport.width, availableHeight / viewport.height);
  const previewWidth = viewport.width * scale;
  const previewHeight = viewport.height * scale;
  const contentWidth = previewWidth * 2 + PREVIEW_GAP_PX;

  return {
    viewport,
    scale,
    previewWidth,
    previewHeight,
    previewGap: PREVIEW_GAP_PX,
    contentWidth,
    modalWidth: contentWidth + MODAL_HORIZONTAL_BODY_PADDING_PX,
  };
}
