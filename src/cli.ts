import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startRamlizer } from "./index";

export async function run(): Promise<void> {
  const argv = yargs(hideBin(process.argv))
    .option("folder", {
      alias: "f",
      describe: "path to the raml files to mock",
      requiresArg: true,
      type: "string"
    })
    .option("port", {
      describe: "port to use",
      type: "number"
    })
    .option("endpoint", {
      describe: "endpoint for scenario configuration",
      type: "string"
    })
    .option("ui", {
      describe: "serve the graphical admin interface at /<endpoint>/ (disable with --no-ui)",
      type: "boolean",
      default: true
    })
    .demandOption("folder")
    .parseSync();

  await startRamlizer(argv as any);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
