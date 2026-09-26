/**
 * node:sqlite loaded through createRequire.
 *
 * vite/vite-node (5.4/2.1) classify builtins by stripping the `node:`
 * prefix and consulting module.builtinModules — but Node lists 'node:sqlite'
 * WITH the prefix, so a static `import "node:sqlite"` is misclassified as an
 * unresolvable bare specifier and vitest fails to load it. A require() call
 * is invisible to bundler analysis and hits Node's real module loader, so
 * this works identically in tsc-built dist and under vitest.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
