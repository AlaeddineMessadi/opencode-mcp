import { readFileSync } from "node:fs";
/** One release identity for CLI, diagnostics and MCP initialization. */
export const packageVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
