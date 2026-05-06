const path = require("node:path");

const isProduction = process.env.NODE_ENV !== "development";
const rootDir = __dirname;
const distSrcDir = path.resolve(rootDir, "dist/src");

const extensions = [".tsx", ".ts", ".jsx", ".js", ".json"];
const extensionAlias = {
  ".js": [".ts", ".tsx", ".js"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

const tsRule = {
  test: /\.[cm]?tsx?$/,
  exclude: /node_modules/,
  use: {
    loader: "ts-loader",
    options: {
      transpileOnly: true,
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
      },
    },
  },
};

const base = {
  mode: isProduction ? "production" : "development",
  context: rootDir,
  cache: {
    type: "filesystem",
    buildDependencies: {
      config: [__filename],
    },
  },
  module: {
    rules: [tsRule],
  },
  resolve: {
    extensions,
    extensionAlias,
  },
  stats: "errors-warnings",
  infrastructureLogging: {
    level: "warn",
  },
};

const renderer = {
  ...base,
  name: "renderer",
  target: ["web", "es2022"],
  entry: {
    renderer: path.resolve(rootDir, "src/renderer.tsx"),
  },
  experiments: {
    outputModule: true,
  },
  output: {
    path: distSrcDir,
    filename: "[name].js",
    chunkFilename: "renderer/chunks/[name].[contenthash:8].js",
    publicPath: "./",
    module: true,
    clean: {
      keep(asset) {
        return asset !== "renderer.js" && !asset.startsWith("renderer/");
      },
    },
  },
  optimization: {
    minimize: isProduction,
    splitChunks: {
      chunks: "initial",
      cacheGroups: {
        react: {
          test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
          name: "react",
          priority: 20,
          enforce: true,
        },
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: "vendor",
          priority: 10,
          reuseExistingChunk: true,
        },
      },
    },
  },
  performance: {
    maxAssetSize: 3 * 1024 * 1024,
    maxEntrypointSize: 3 * 1024 * 1024,
  },
};

function preloadConfig(name, entry, filename) {
  return {
    ...base,
    name,
    target: "electron-preload",
    entry: {
      [name]: path.resolve(rootDir, entry),
    },
    output: {
      path: distSrcDir,
      filename,
      library: {
        type: "commonjs2",
      },
    },
    externals: {
      electron: "commonjs2 electron",
    },
    optimization: {
      minimize: false,
    },
  };
}

module.exports = [
  renderer,
  preloadConfig("preload", "src/preload.ts", "preload.cjs"),
  preloadConfig("pluginPreload", "src/plugin-preload.ts", "plugin-preload.cjs"),
];
