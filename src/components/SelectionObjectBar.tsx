import type React from 'react';
import type { CameraTarget } from '../camera/types';
import { getSelectionObjectName, SELECTION_COLORS } from './comparisonSelectionModel';

interface Props {
  targets: CameraTarget[];
  onLocate: (target: CameraTarget) => void;
  onRemove?: (id: string) => void;
  onClear?: () => void;
}

export default function SelectionObjectBar({ targets, onLocate, onRemove, onClear }: Props) {
  if (!targets.length) return null;
  return (
    <section className="map-selection-bar" aria-label="Selected objects">
      <span className="map-selection-heading">Objects</span>
      <div className="map-selection-items">
        {targets.map((target, index) => (
          <div
            className="map-selection-item"
            key={target.id}
            style={{ '--selection-color': `rgb(${SELECTION_COLORS[index].join(',')})` } as React.CSSProperties}>
            <span className="map-selection-type">{target.type}</span>
            <button
              type="button"
              className="map-selection-name"
              title={getSelectionObjectName(target)}
              aria-label={`Locate ${target.type}: ${getSelectionObjectName(target)}`}
              onClick={() => onLocate(target)}>
              {getSelectionObjectName(target)}
            </button>
            {onRemove && (
              <button
                type="button"
                className="map-selection-remove"
                aria-label={`Remove ${target.type}: ${getSelectionObjectName(target)}`}
                onClick={() => onRemove(target.id)}>
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {onClear && (
        <button type="button" className="map-selection-clear" aria-label="Clear selected objects" onClick={onClear}>
          Clear
        </button>
      )}
    </section>
  );
}
