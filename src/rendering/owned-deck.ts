import { Deck, type View } from '@deck.gl/core';
import type { Device } from '@luma.gl/core';

/** Deck.finalize() cleans up layers but leaves its WebGL context for GC. Repeatedly mounted renderers must release
 * their owned device when the canvas detaches, instead of exhausting the browser
 * context limit. Externally supplied devices and live StrictMode canvases survive. */
export class OwnedDeck<ViewsT extends View | View[] | null = null> extends Deck<ViewsT> {
  private finalized = false;

  override finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const canvas = this.getCanvas();
    // Device initialization can still be pending when React unmounts DeckGL.
    // Capture the promise before the base finalizer clears animationLoop.
    const device = this.device;
    const pendingDevice = this.animationLoop?.props.device;
    const ownsDevice = !this.props.device && !this.props.gl;
    super.finalize();
    if (!ownsDevice || !canvas) return;

    const release = (owned: Device) => {
      // StrictMode may finalize one Deck and reuse its still-mounted canvas for
      // the next instance. Only detached canvases belong to completed unmounts.
      if (canvas.isConnected || owned.canvasContext?.canvas !== canvas) return;
      owned.destroy();
      if (!owned.isLost) owned.loseDevice();
      owned.canvasContext?.destroy();
    };
    if (device) release(device);
    else if (pendingDevice) {
      void Promise.resolve(pendingDevice).then(
        (created) => {
          // Let AnimationLoop's pending initialization observe its stopped state
          // before destroying the canvas observers or losing the new context.
          queueMicrotask(() => release(created));
        },
        // AnimationLoop already reports device-creation errors; no device exists
        // to release when its creation promise rejects.
        () => {},
      );
    }
  }
}
