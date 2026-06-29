import { build } from "esbuild";

const emptyNodeBuiltinPlugin = {
  name: "empty-node-builtins",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^node:(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: "empty-node-builtin"
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "empty-node-builtin" }, () => ({
      contents: "export default {}; export const promises = {};",
      loader: "js"
    }));
  }
};

await build({
  entryPoints: ["src/optimize-worker-source.js"],
  outfile: "extension/optimize-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome109", "edge109"],
  legalComments: "none",
  sourcemap: false,
  minify: false,
  plugins: [emptyNodeBuiltinPlugin]
});

console.log("Bundled extension/optimize-worker.js");
