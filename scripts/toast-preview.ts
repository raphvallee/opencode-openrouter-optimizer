/**
 * Renders a headless TUI frame showing what the routing-failure toast looks like
 * in the OpenCode TUI, then prints the captured frame to stdout.
 *
 * The real toast is drawn by the OpenCode host when the plugin calls
 * context.ui.toast.show({ variant: "error" }); this script reproduces that host
 * toast (bottom-right corner, error styling) with the same message the plugin
 * writes, so the failure is visible without running a live OpenCode session.
 */

import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

const WIDTH = 80
const HEIGHT = 24

const MESSAGE =
  "OpenRouter optimizer could not route vendor/model (no ranking available); the request was sent unfiltered."

const { renderer, renderOnce, flush, captureCharFrame, dispose } = await createTestRenderer({
  width: WIDTH,
  height: HEIGHT,
})

// Mock transcript: a user prompt and a running-agent line, dimmed behind the toast.
const transcript = new BoxRenderable(renderer, {
  backgroundColor: "#0e0e0e",
  width: WIDTH,
  height: HEIGHT,
})
transcript.add(
  new TextRenderable(renderer, {
    content: "> fix the failing stats test",
    fg: "#c0c0c0",
  }),
)
transcript.add(
  new TextRenderable(renderer, {
    content: "",
    height: 1,
  }),
)
transcript.add(
  new TextRenderable(renderer, {
    content: "  [optimizer] routing vendor/model via OpenRouter...",
    fg: "#606060",
  }),
)

// The host toast: bottom-right corner, error variant styling.
const toast = new BoxRenderable(renderer, {
  backgroundColor: "#5f2120",
  borderColor: "#f28b82",
  border: true,
  borderStyle: "rounded",
  title: "OpenRouter optimizer",
  titleColor: "#ffffff",
  titleAlignment: "left",
  position: "absolute",
  left: WIDTH - 74,
  top: HEIGHT - 6,
  width: 73,
  height: 5,
  zIndex: 10,
})
toast.add(
  new TextRenderable(renderer, {
    content: MESSAGE,
    fg: "#fdd3cf",
    width: 69,
    wrapMode: "char",
    margin: 1,
  }),
)

renderer.root.add(transcript)
renderer.root.add(toast)

await renderOnce()
await flush()

const frame = captureCharFrame()
console.log("=== captured TUI frame ===")
console.log(frame)

await dispose()
