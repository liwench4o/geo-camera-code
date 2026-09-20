const path = require('path');
const webpack = require('webpack');
const tailwindcssPostcss = require('@tailwindcss/postcss');
const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const trajectoryV2 = process.env.GEO_CAMERA_TRAJECTORY_V2 !== 'false';

const dev = merge(common, {
  mode: 'development',
  plugins: [
    new webpack.DefinePlugin({
      __GEO_CAMERA_TRAJECTORY_V2__: JSON.stringify(trajectoryV2),
    }),
  ],
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
            },
          },
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                plugins: [tailwindcssPostcss],
              },
            },
          },
        ],
      },
    ],
  },
  devServer: {
    static: [
      {
        directory: path.join(__dirname, 'dist'),
      },
    ],
    client: {
      logging: 'info',
      overlay: {
        errors: true,
        warnings: false,
      },
    },
    compress: true,
    hot: true,
    port: 9000,
  },
});

module.exports = dev;
