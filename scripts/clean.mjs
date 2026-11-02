/**
 * Remove build output before a fresh build.
 *
 * `rimraf` and friends are not a dependency of this package, and the delete has
 * to work the same on Windows, macOS and Linux, so the platform's own file
 * tools do it.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = [join(root, "dist")];

await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
