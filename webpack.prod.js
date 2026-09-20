const { merge } = require('webpack-merge');
const webpack = require('webpack');
const common = require('./webpack.common.js');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const tailwindcssPostcss = require('@tailwindcss/postcss');
const TerserPlugin = require('terser-webpack-plugin');
const trajectoryV2 = process.env.GEO_CAMERA_TRAJECTORY_V2 !== 'false';

const prod = merge(common, {
  mode: 'production',
  plugins: [
    new webpack.DefinePlugin({
      __GEO_CAMERA_TRAJECTORY_V2__: JSON.stringify(trajectoryV2),
    }),
    new MiniCssExtractPlugin({
      filename: '[name].css',
      chunkFilename: '[id].css',
    }),
  ],
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
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
  optimization: {
    minimizer: [
      new CssMinimizerPlugin(),
      new TerserPlugin({
        parallel: true,
        terserOptions: {
          compress: {
            passes: 2,
          },
        },
      }),
    ],
  },
});

module.exports = prod;
