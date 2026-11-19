import { pathToFileURL } from "node:url";
import { main } from "./report-downdetector.mjs";

export * from "./report-downdetector.mjs";

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
