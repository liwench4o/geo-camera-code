import assert from 'node:assert/strict';
import path from 'node:path';
import { DefinePlugin } from 'webpack';

const original = process.env.GEO_CAMERA_TRAJECTORY_V2;
try {
  for (const filename of ['webpack.dev.js', 'webpack.prod.js']) {
    const configPath = require.resolve(path.resolve(filename));
    const cached = require.cache[configPath];
    try {
      for (const [value, expected] of [
        [undefined, true],
        ['true', true],
        ['false', false],
        ['0', true],
        ['FALSE', true],
      ] as const) {
        if (value === undefined) delete process.env.GEO_CAMERA_TRAJECTORY_V2;
        else process.env.GEO_CAMERA_TRAJECTORY_V2 = value;
        delete require.cache[configPath];
        const config = require(configPath) as { plugins: unknown[] };
        const flags = config.plugins
          .filter((plugin): plugin is DefinePlugin => plugin instanceof DefinePlugin)
          .filter((plugin) => '__GEO_CAMERA_TRAJECTORY_V2__' in plugin.definitions);
        assert.equal(flags.length, 1, `${filename} defines one unambiguous trajectory flag`);
        assert.equal(
          flags[0].definitions.__GEO_CAMERA_TRAJECTORY_V2__,
          JSON.stringify(expected),
          `${filename} enables trajectory playback by default and accepts the explicit false escape hatch`,
        );
      }
    } finally {
      if (cached) require.cache[configPath] = cached;
      else delete require.cache[configPath];
    }
  }
} finally {
  if (original === undefined) delete process.env.GEO_CAMERA_TRAJECTORY_V2;
  else process.env.GEO_CAMERA_TRAJECTORY_V2 = original;
}
