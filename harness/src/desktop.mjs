// Native desktop control: the model can look at the screen and drive the mouse and
// keyboard, the way Claude's computer use does. Windows only (Win32 SendInput through
// one PowerShell per action, no extra dependency).
//
// Safety is the permissions layer's, not this file's: desktop_screenshot and
// desktop_windows only look; every other desktop_* tool acts on this computer outside the
// workspace, so in Workspace write mode it asks the person first (permissions.mjs), and
// Read only / plan mode refuse it. The whole family is off unless the person turns
// "Desktop control" on in Settings. `window` limits an action to one app: it is focused
// first and coordinates are relative to its top-left corner.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as act from "./desktop-actions.mjs";

export const DESKTOP_TOOLS = ["desktop_screenshot", "desktop_zoom", "desktop_windows", "desktop_move", "desktop_click", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "desktop_wait"];
export const DESKTOP_LOOK_TOOLS = ["desktop_screenshot", "desktop_zoom", "desktop_windows", "desktop_wait"];

const WINDOW = { type: "string", description: "Optional: part of a window title (from desktop_windows). The window is focused first and x/y are measured from its top-left corner. Omit for the whole screen." };

export function desktopTools({ root, onImage = null, emit = () => {} }) {
  const shotDir = join(root, ".rosalena", "desktop");
  // The last screenshot's scale: a model reads coordinates off the (downscaled) image,
  // so they are scaled back to real pixels here instead of trusting it to do the sum.
  const last = { scale: 1, window: null };
  const real = (v) => (v === undefined || v === null ? v : Math.round(Number(v) / (last.scale || 1)));
  const sameFrame = (window) => (window ?? null) === last.window;
  const fix = (args, keys) => {
    if (!sameFrame(args.window)) return args; // coordinates from another frame: taken as given
    const out = { ...args };
    for (const k of keys) out[k] = real(args[k]);
    return out;
  };
  const after = (what) => `${what}. Take desktop_screenshot to check the result before the next action.`;

  return {
    desktop_screenshot: {
      description:
        "Take a screenshot of the whole screen, or of one window, and look at it (shown to you after this step). Coordinates for desktop_click/drag/scroll are read straight off this image: use the pixel you see, the scaling is undone for you. Needs a model that can see images.",
      parameters: { type: "object", properties: { window: WINDOW } },
      async run({ window } = {}) {
        if (typeof onImage !== "function") throw new Error("this run cannot show images to the model, so it cannot see the screen");
        mkdirSync(shotDir, { recursive: true });
        const file = join(shotDir, `screen-${Date.now()}.png`);
        const shot = await act.screenshot({ file, window });
        last.scale = shot.scale || 1;
        last.window = window ?? null;
        const { loadImage } = await import("./images.mjs");
        const image = loadImage(file);
        onImage(image);
        emit({ type: "image", path: file, bytes: image.bytes, width: image.dims?.width ?? null, height: image.dims?.height ?? null });
        const w = image.dims?.width ?? Math.round(shot.width * last.scale);
        const h = image.dims?.height ?? Math.round(shot.height * last.scale);
        return `screenshot of ${window ? `the window "${window}"` : "the screen"}: ${w}x${h} as shown (real size ${shot.width}x${shot.height}). Give coordinates in the ${w}x${h} image's pixels${window ? ", with the same window" : ""}.`;
      },
    },
    desktop_zoom: {
      description:
        "Look closer at part of the last screenshot, at full resolution: x, y, width, height in that screenshot's pixels. For small text, icons, a plugin's knob. Clicks still use the last desktop_screenshot's pixels, not this image's.",
      parameters: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
      },
      async run(args) {
        if (typeof onImage !== "function") throw new Error("this run cannot show images to the model, so it cannot see the screen");
        mkdirSync(shotDir, { recursive: true });
        const file = join(shotDir, `zoom-${Date.now()}.png`);
        // The region is given in the last screenshot's pixels: back to real pixels, same frame.
        const region = { x: real(args.x), y: real(args.y), width: real(args.width), height: real(args.height) };
        const shot = await act.screenshot({ file, window: last.window, region, maxWidth: 1600 });
        const { loadImage } = await import("./images.mjs");
        const image = loadImage(file);
        onImage(image);
        emit({ type: "image", path: file, bytes: image.bytes, width: image.dims?.width ?? null, height: image.dims?.height ?? null });
        return `zoomed in on ${shot.width}x${shot.height} real pixels at ${region.x},${region.y}${last.window ? ` in "${last.window}"` : ""}. Clicks still use the last full screenshot's pixels.`;
      },
    },
    desktop_move: {
      description: "Move the mouse to x,y without clicking (pixels in the last screenshot): open a hover menu, show a tooltip, highlight a target.",
      parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, window: WINDOW }, required: ["x", "y"] },
      async run(args) {
        const a = fix(args, ["x", "y"]);
        await act.movePointer(a);
        return after(`moved the pointer to ${a.x},${a.y}`);
      },
    },
    desktop_wait: {
      description: "Wait a moment (up to 10 seconds) for something on screen to finish: a window opening, a render, a load.",
      parameters: { type: "object", properties: { seconds: { type: "number" } } },
      async run({ seconds } = {}) {
        const s = Math.max(0.2, Math.min(10, Number(seconds) || 1));
        await new Promise((done) => setTimeout(done, s * 1000));
        return `waited ${s} s. Take desktop_screenshot to see what changed.`;
      },
    },
    desktop_windows: {
      description: "List the visible windows (title, process, position, size; * marks the focused one). Use a title from here as the `window` argument to keep actions inside one app.",
      parameters: { type: "object", properties: {} },
      async run() {
        const text = await act.listWindows();
        return text || "no visible windows";
      },
    },
    desktop_click: {
      description: "Click the mouse at x,y (pixels in the last screenshot). button: left (default), right or middle; double: true for a double-click.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean" },
          window: WINDOW,
        },
        required: ["x", "y"],
      },
      async run(args) {
        const a = fix(args, ["x", "y"]);
        await act.click(a);
        return after(`${a.double ? "double-" : ""}${a.button ?? "left"}-clicked at ${a.x},${a.y}${a.window ? ` in "${a.window}"` : ""} (real pixels)`);
      },
    },
    desktop_drag: {
      description: "Press at from_x,from_y, move to to_x,to_y and release (pixels in the last screenshot): sliders, selections, moving things.",
      parameters: {
        type: "object",
        properties: {
          from_x: { type: "number" },
          from_y: { type: "number" },
          to_x: { type: "number" },
          to_y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          window: WINDOW,
        },
        required: ["from_x", "from_y", "to_x", "to_y"],
      },
      async run(args) {
        const a = fix(args, ["from_x", "from_y", "to_x", "to_y"]);
        await act.drag(a);
        return after(`dragged from ${a.from_x},${a.from_y} to ${a.to_x},${a.to_y}`);
      },
    },
    desktop_scroll: {
      description: "Scroll the mouse wheel: amount in notches, negative scrolls down, positive up (default -3). Optional x,y moves the pointer there first.",
      parameters: { type: "object", properties: { amount: { type: "number" }, x: { type: "number" }, y: { type: "number" }, window: WINDOW } },
      async run(args = {}) {
        const a = fix(args, ["x", "y"]);
        await act.scroll(a);
        return after(`scrolled ${a.amount ?? -3}`);
      },
    },
    desktop_type: {
      description: "Type text into whatever has keyboard focus (click the field first). \\n presses Enter. Never use it for passwords or card numbers.",
      parameters: { type: "object", properties: { text: { type: "string" }, window: WINDOW }, required: ["text"] },
      async run({ text, window }) {
        await act.typeText({ text, window });
        return after(`typed ${String(text).length} character(s)`);
      },
    },
    desktop_key: {
      description: "Press a key or shortcut: \"enter\", \"esc\", \"ctrl+a\", \"ctrl+shift+s\", \"alt+f4\", \"f5\", \"space\", arrows (\"up\"...). repeat presses it several times.",
      parameters: { type: "object", properties: { keys: { type: "string" }, repeat: { type: "number" }, window: WINDOW }, required: ["keys"] },
      async run({ keys, repeat, window }) {
        await act.pressKeys({ keys, repeat, window });
        return after(`pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}`);
      },
    },
  };
}
