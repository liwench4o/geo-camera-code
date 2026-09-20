import { Button, Card, Space, Tooltip, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type { Effect } from '@deck.gl/core';
import { DeckGL } from '@deck.gl/react';
import { Map } from 'react-map-gl/maplibre';
import type { CameraView, DeckglLayer } from '../interfaces';
import type { ViewportSize } from '../camera/types';
import { applyVisualizationCameraConstraints } from '../visualization/camera-constraints';
import type { VisualizationCameraConstraints } from '../visualization/types';
import { getViewStatePreviewMapProps } from './viewStatePreviewMap';

const { Text } = Typography;

export interface ViewStatePreviewProps {
  id: string;
  title: string;
  layers: DeckglLayer[];
  effects: Effect[];
  mapStyle?: string;
  cameraConstraints: VisualizationCameraConstraints;
  viewState: CameraView;
  viewportSize: ViewportSize;
  displayScale: number;
  canSave: boolean;
  onViewStateChange: (event: { viewState: unknown }) => void;
  onReset: () => void;
  onSave?: () => void;
}

function ViewStatePreview({
  id,
  title,
  layers,
  effects,
  mapStyle,
  cameraConstraints,
  viewState,
  viewportSize,
  displayScale,
  canSave,
  onViewStateChange,
  onReset,
  onSave,
}: ViewStatePreviewProps) {
  return (
    <Card
      className="view-state-preview h-full w-full"
      variant="borderless"
      styles={{ body: { height: '100%', padding: 0 } }}>
      <div
        style={{
          position: 'absolute',
          width: viewportSize.width,
          height: viewportSize.height,
          transform: `scale(${displayScale})`,
          transformOrigin: 'top left',
        }}>
        <DeckGL
          key={`deck-${id}`}
          width={viewportSize.width}
          height={viewportSize.height}
          layers={layers}
          effects={effects}
          viewState={applyVisualizationCameraConstraints({ ...viewState, transitionDuration: 0 }, cameraConstraints)}
          onViewStateChange={onViewStateChange}
          // Deck's event manager accounts for CSS scaling when locating the pointer.
          controller={{ doubleClickZoom: false, inertia: false }}>
          <Map {...getViewStatePreviewMapProps(id, mapStyle, cameraConstraints)} />
        </DeckGL>
      </div>
      <div className="view-state-preview-title">
        <Text className="text-white!">{title}</Text>
      </div>
      <div className="absolute! top-0 right-0 m-4">
        <Space direction="vertical" size={2}>
          <Tooltip title={`Reset ${title.toLowerCase()}`} placement="left">
            <Button
              size="large"
              className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
              icon={<ReloadOutlined className="text-2xl! text-white/75! hover:text-white!" />}
              onClick={onReset}
            />
          </Tooltip>
          {onSave && (
            <Tooltip title={`Save ${title.toLowerCase()}`} placement="left">
              <Button
                size="large"
                disabled={!canSave}
                className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
                icon={<SaveOutlined className="text-2xl! text-white/75! hover:text-white!" />}
                onClick={onSave}
              />
            </Tooltip>
          )}
        </Space>
      </div>
    </Card>
  );
}

export default ViewStatePreview;
