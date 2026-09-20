import React from 'react';
import { Alert, Button, Modal, Space } from 'antd';
import type { ViewportSize } from '../camera/types';
import type { ResolvedVisualizationRuntime } from '../visualization/types';
import type { ViewStateEditorDraft } from './viewStateEditorModel';
import { getViewStatePreviewLayout } from './viewStatePreviewLayout';
import ViewStatePreview from './ViewStatePreview';

export interface ViewStateEditorModalProps {
  open: boolean;
  draft?: ViewStateEditorDraft;
  runtime?: ResolvedVisualizationRuntime;
  viewportSize?: ViewportSize;
  canSave: boolean;
  onCancel: () => void;
  onInitialViewStateChange: (event: { viewState: unknown }) => void;
  onFinalViewStateChange: (event: { viewState: unknown }) => void;
  onInitialReset: () => void;
  onFinalReset: () => void;
  onSave: () => void;
}

function getWindowSize(): ViewportSize | undefined {
  return typeof window === 'undefined' ? undefined : { width: window.innerWidth, height: window.innerHeight };
}

function ViewStateEditorModal({
  open,
  draft,
  runtime,
  viewportSize,
  canSave,
  onCancel,
  onInitialViewStateChange,
  onFinalViewStateChange,
  onInitialReset,
  onFinalReset,
  onSave,
}: ViewStateEditorModalProps) {
  const [windowSize, setWindowSize] = React.useState(getWindowSize);
  React.useEffect(() => {
    if (!open) return;
    const updateWindowSize = () => setWindowSize(getWindowSize());
    updateWindowSize();
    window.addEventListener('resize', updateWindowSize);
    return () => window.removeEventListener('resize', updateWindowSize);
  }, [open]);
  const initialLayers = React.useMemo(
    () =>
      runtime?.createLayers({
        idPrefix: 'view-state-initial-',
        interactive: false,
        transitions: false,
      }) ?? [],
    [runtime],
  );
  const finalLayers = React.useMemo(
    () =>
      runtime?.createLayers({
        idPrefix: 'view-state-final-',
        interactive: false,
        transitions: false,
      }) ?? [],
    [runtime],
  );
  const isReady = Boolean(draft && runtime);
  const previewLayout = React.useMemo(
    () => getViewStatePreviewLayout(viewportSize, windowSize),
    [viewportSize, windowSize],
  );

  return (
    <Modal
      className="view-state-modal"
      title="Initial/Final View State Editor"
      centered={true}
      open={open}
      onCancel={onCancel}
      footer={
        <Space>
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="primary" disabled={!canSave} onClick={onSave}>
            Save changes
          </Button>
        </Space>
      }
      width={previewLayout.modalWidth}
      styles={{ body: { overflowX: 'auto' } }}>
      {open && (
        <Space direction="vertical" size={8} className="w-full">
          {!isReady && (
            <Alert
              type="warning"
              showIcon={true}
              message="No camera is selected"
              description="Select a camera movement before editing its view states."
            />
          )}
          {draft && runtime && (
            <div className="view-state-preview-scroll">
              <div
                className="view-state-preview-strip"
                style={{
                  width: previewLayout.contentWidth,
                  height: previewLayout.previewHeight,
                  gap: previewLayout.previewGap,
                }}>
                <div
                  className="view-state-preview-frame"
                  style={{
                    width: previewLayout.previewWidth,
                    height: previewLayout.previewHeight,
                  }}>
                  <ViewStatePreview
                    id="initial-view-state"
                    title="Initial State"
                    layers={initialLayers}
                    effects={runtime.effects}
                    mapStyle={runtime.mapStyle}
                    cameraConstraints={{ minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 85 }}
                    viewportSize={previewLayout.viewport}
                    displayScale={previewLayout.scale}
                    viewState={draft.initialViewState}
                    canSave={canSave}
                    onViewStateChange={onInitialViewStateChange}
                    onReset={onInitialReset}
                  />
                </div>
                <div
                  className="view-state-preview-frame"
                  style={{
                    width: previewLayout.previewWidth,
                    height: previewLayout.previewHeight,
                  }}>
                  <ViewStatePreview
                    id="final-view-state"
                    title="Final State"
                    layers={finalLayers}
                    effects={runtime.effects}
                    mapStyle={runtime.mapStyle}
                    cameraConstraints={{ minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 85 }}
                    viewportSize={previewLayout.viewport}
                    displayScale={previewLayout.scale}
                    viewState={draft.finalViewState}
                    canSave={canSave}
                    onViewStateChange={onFinalViewStateChange}
                    onReset={onFinalReset}
                  />
                </div>
              </div>
            </div>
          )}
        </Space>
      )}
    </Modal>
  );
}

export default ViewStateEditorModal;
