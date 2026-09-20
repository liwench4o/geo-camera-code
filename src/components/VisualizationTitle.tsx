import React from 'react';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Popover } from 'antd';
import { getDatasetInformation } from '../visualization/dataset-info';

interface VisualizationTitleProps {
  title: string;
  datasetId?: string;
  visualizationId?: string;
}

export default class VisualizationTitle extends React.PureComponent<VisualizationTitleProps, { open: boolean }> {
  state = { open: false };
  private triggerRef = React.createRef<HTMLButtonElement>();
  private panelRef = React.createRef<HTMLElement>();

  private handleBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!this.triggerRef.current?.contains(next) && !this.panelRef.current?.contains(next)) {
      this.setState({ open: false });
    }
  };

  private handleOpenChange = (open: boolean) => {
    // Moving the pointer away must not dismiss source links being used by keyboard.
    if (!open && this.panelRef.current?.contains(document.activeElement)) return;
    this.setState({ open });
  };

  private handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.triggerRef.current?.focus({ preventScroll: true });
      this.setState({ open: false });
      return;
    }
    if (event.key !== 'Tab' || !this.state.open) return;

    const panel = this.panelRef.current;
    const links = panel?.querySelectorAll<HTMLAnchorElement>('a[href]');
    if (event.target === this.triggerRef.current && !event.shiftKey) {
      event.preventDefault();
      (links?.[0] ?? panel)?.focus({ preventScroll: true });
    } else if (panel?.contains(event.target as Node)) {
      const atStart = event.target === links?.[0] || event.target === panel;
      const atEnd = event.target === links?.[links.length - 1] || event.target === panel;
      if (event.shiftKey && atStart) {
        event.preventDefault();
        this.triggerRef.current?.focus({ preventScroll: true });
      } else if (!event.shiftKey && atEnd) {
        // Resume the page's normal tab order after the trigger, outside the portal.
        this.triggerRef.current?.focus({ preventScroll: true });
        this.setState({ open: false });
      }
    }
  };

  render() {
    const { title, datasetId, visualizationId } = this.props;
    const info = getDatasetInformation(datasetId, visualizationId);
    return (
      <div className="map-canvas-title" onKeyDown={this.handleKeyDown} onBlur={this.handleBlur}>
        <h4 className="map-canvas-title-text" title={title}>
          {title}
        </h4>
        <Popover
          placement="bottomLeft"
          trigger={['hover', 'click']}
          open={this.state.open}
          onOpenChange={this.handleOpenChange}
          mouseEnterDelay={0.15}
          mouseLeaveDelay={0.2}
          classNames={{ root: 'visualization-info-popover' }}
          content={
            <section
              ref={this.panelRef}
              className="visualization-info"
              role="dialog"
              tabIndex={-1}
              aria-label={`About ${title}`}>
              <h4>{title}</h4>
              <h5>Dataset</h5>
              <p>{info.description}</p>
              <h5>Visualization</h5>
              <p>{info.visualization}</p>
              {info.legend && (
                <div className="visualization-info-legend">
                  {info.legend.map((entry) => (
                    <span key={entry.label}>
                      <i style={{ background: entry.color }} aria-hidden="true" />
                      {entry.label}
                    </span>
                  ))}
                </div>
              )}
              <h5>Source</h5>
              {info.sources.length ? (
                <ul>
                  {info.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.label}
                        <span aria-hidden="true"> ↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Not provided.</p>
              )}
            </section>
          }>
          <button
            ref={this.triggerRef}
            type="button"
            className="map-information-button"
            aria-label={`About ${title}`}
            aria-haspopup="dialog"
            aria-expanded={this.state.open}
            onFocus={(event) => {
              if (event.currentTarget.matches(':focus-visible')) this.setState({ open: true });
            }}>
            <InfoCircleOutlined aria-hidden="true" />
          </button>
        </Popover>
      </div>
    );
  }
}
