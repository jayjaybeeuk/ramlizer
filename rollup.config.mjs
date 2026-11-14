import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);
const dependencies = Object.keys(pkg.dependencies || {});
const builtins = [...builtinModules, ...builtinModules.map(m => `node:${m}`)];

const isExternal = id => {
  return (
    builtins.includes(id) ||
    id.startsWith("node:") ||
    dependencies.some(dep => id === dep || id.startsWith(dep + "/"))
  );
};

// Ships the static admin interface (src/ui) next to the bundles as dist/ui.
const copyAdminUi = () => ({
  name: "copy-admin-ui",
  buildStart() {
    for (const file of readdirSync("src/ui")) {
      this.addWatchFile(`src/ui/${file}`);
    }
  },
  generateBundle() {
    for (const file of readdirSync("src/ui")) {
      this.emitFile({
        type: "asset",
        fileName: `ui/${file}`,
        source: readFileSync(`src/ui/${file}`)
      });
    }
  }
});

export default [
  {
    input: "src/index.ts",
    external: isExternal,
    output: [
      {
        file: "dist/index.js",
        format: "cjs",
        exports: "named",
        sourcemap: true
      },
      {
        file: "dist/index.mjs",
        format: "es",
        sourcemap: true
      }
    ],
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        declarationDir: "./dist"
      }),
      copyAdminUi()
    ]
  },
  {
    input: "src/cli.ts",
    external: isExternal,
    output: {
      file: "dist/cli.js",
      format: "cjs",
      banner: "#!/usr/bin/env node\n",
      sourcemap: true
    },
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false
      })
    ]
  }
];
