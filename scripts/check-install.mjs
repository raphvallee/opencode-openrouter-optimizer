/**
 * Check that an installed copy of this package exposes both plugin parts.
 *
 * OpenCode loads the server part from "." and the TUI part from "./tui", so a
 * broken exports map or a missing build shows up here instead of in a user's
 * session.
 *
 * Run it with Bun from a project that has the package installed, for example
 * after `npm install <tarball>`:
 *
 *   cp scripts/check-install.mjs <project>/check-install.mjs
 *   cd <project> && bun check-install.mjs
 *
 * Bun is required because the server part reads its state through
 * `bun:sqlite`.
 */

const name = process.argv[2] ?? "opencode-openrouter-optimizer";

const server = await import(name);
const tui = await import(`${name}/tui`);

if (typeof server.default?.id !== "string")
  throw new Error(`${name} does not export a server plugin with an id`);
if (typeof tui.default?.id !== "string")
  throw new Error(`${name}/tui does not export a TUI plugin with an id`);

console.log(`server part: ${server.default.id}`);
console.log(`TUI part: ${tui.default.id}`);
