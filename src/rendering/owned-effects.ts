import { AmbientLight, DirectionalLight, LightingEffect, PointLight, type Effect } from '@deck.gl/core';

/** Registry effects are shared descriptors. Their GPU state belongs to one Deck.
 * Reconstruct each supported effect and light; never hand a registry singleton
 * to a renderer, including two simultaneously mounted comparison panes. */
export function createOwnedEffects(effects: Effect[]): Effect[] {
  return effects.map((effect) => {
    if (!(effect instanceof LightingEffect)) {
      throw new Error(`Cannot safely clone rendering effect：${effect.id}`);
    }
    const lights = Object.fromEntries(
      Object.entries(effect.props).map(([name, light]) => {
        const common = {
          id: light.id,
          color: [...light.color] as [number, number, number],
          intensity: light.intensity,
        };
        if (light instanceof AmbientLight) return [name, new AmbientLight(common)];
        if (light instanceof PointLight)
          return [
            name,
            new PointLight({ ...common, position: [...light.position], attenuation: [...light.attenuation] }),
          ];
        if (light instanceof DirectionalLight)
          return [name, new DirectionalLight({ ...common, direction: [...light.direction], _shadow: light.shadow })];
        throw new Error(`Cannot safely clone rendering light：${name}`);
      }),
    );
    const owned = new LightingEffect(lights);
    owned.shadowColor = [...effect.shadowColor];
    return owned;
  });
}
