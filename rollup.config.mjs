import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";

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
      })
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
