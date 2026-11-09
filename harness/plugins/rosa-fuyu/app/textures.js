// Fuyu's block textures: 16 x 16 pixel art painted on canvases at start-up (nothing to
// download), plus the little isometric cube icons for the hotbar.

import { mulberry32 } from "./world.js";

function paint(seed, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  const rnd = mulberry32(seed);
  const px = (x, y, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, 1, 1);
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  draw({ ctx, px, rnd, pick });
  return canvas;
}

const speckle = (seed, colours) =>
  paint(seed, ({ px, pick }) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, pick(colours));
  });

const GRASS = ["#7cc35a", "#7cc35a", "#74bb53", "#86cc63", "#6cb04b", "#7fc75c"];
const DIRT = ["#9b6b43", "#9b6b43", "#8e613c", "#a8774c", "#87593a"];
const STONE = ["#a0a6ad", "#a0a6ad", "#aab0b6", "#959ba2", "#b5babf"];
const SNOW = ["#f6fafd", "#f6fafd", "#eaf1f7", "#ffffff", "#e2ebf3"];

export function paintTextures() {
  const t = {};
  t.grassTop = speckle(11, GRASS);
  t.dirt = speckle(12, DIRT);
  t.grassSide = paint(13, ({ px, rnd, pick }) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, pick(DIRT));
    for (let x = 0; x < 16; x++) {
      const depth = 3 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.25 ? 1 : 0);
      for (let y = 0; y < depth; y++) px(x, y, pick(GRASS));
    }
  });
  t.stone = paint(14, ({ ctx, px, rnd, pick }) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, pick(STONE));
    ctx.fillStyle = "#858b92";
    for (let k = 0; k < 4; k++) {
      let x = Math.floor(rnd() * 16);
      let y = Math.floor(rnd() * 16);
      for (let s = 0; s < 4; s++) {
        ctx.fillRect(x & 15, y & 15, 1, 1);
        x += rnd() < 0.5 ? 1 : 0;
        y += 1;
      }
    }
  });
  t.sand = speckle(15, ["#efdca4", "#efdca4", "#e7d296", "#f6e7ba", "#ead69d"]);
  t.bark = paint(16, ({ px, rnd, pick }) => {
    for (let x = 0; x < 16; x++) {
      const base = pick(["#7a5232", "#6e4a2d", "#85593a"]);
      for (let y = 0; y < 16; y++) px(x, y, rnd() < 0.12 ? "#5f3f26" : base);
    }
  });
  t.woodTop = paint(17, ({ px }) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        let c = Math.floor(d * 0.9) % 2 ? "#c99a62" : "#b4844f";
        if (x === 0 || y === 0 || x === 15 || y === 15) c = "#6e4a2d";
        px(x, y, c);
      }
    }
  });
  t.planks = paint(18, ({ px, rnd }) => {
    for (let y = 0; y < 16; y++) {
      const row = Math.floor(y / 4);
      const shade = ["#c8955b", "#c18e54", "#cf9c62", "#c4915a"][row];
      const seamX = (row * 5 + 3) % 16;
      for (let x = 0; x < 16; x++) {
        let c = shade;
        if (y % 4 === 3) c = "#94653a";
        else if (x === seamX) c = "#9e6e40";
        else if (rnd() < 0.12) c = "#d8a86e";
        px(x, y, c);
      }
    }
  });
  t.leaves = paint(19, ({ px, rnd, pick }) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (rnd() < 0.13) continue;
        px(x, y, pick(["#4f9a45", "#4a9141", "#5aa84e", "#3f8538", "#67b65a", "#4f9a45"]));
      }
    }
  });
  t.glass = paint(20, ({ ctx, px }) => {
    ctx.fillStyle = "rgba(205,236,255,0.22)";
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 16; i++) {
      px(i, 0, "rgba(244,251,255,0.95)");
      px(i, 15, "rgba(244,251,255,0.95)");
      px(0, i, "rgba(244,251,255,0.95)");
      px(15, i, "rgba(244,251,255,0.95)");
    }
    for (let k = 0; k < 4; k++) px(3 + k, 7 - k, "rgba(255,255,255,0.75)");
    for (let k = 0; k < 3; k++) px(6 + k, 7 - k, "rgba(255,255,255,0.55)");
  });
  t.lantern = paint(21, ({ px }) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let c = "#ffcf73";
        const centre = Math.hypot(x - 7.5, y - 7.5);
        if (centre < 4.2) c = "#fff0c4";
        else if (centre < 6) c = "#ffdf96";
        if (x === 4 || x === 11) c = "#f0a548";
        if (y < 2 || y > 13 || x === 0 || x === 15) c = "#5a3a22";
        px(x, y, c);
      }
    }
  });
  t.roof = paint(22, ({ px, pick }) => {
    for (let y = 0; y < 16; y++) {
      const row = Math.floor(y / 4);
      const offset = (row % 2) * 4;
      for (let x = 0; x < 16; x++) {
        const local = (x + offset) % 8;
        let c = pick(["#c8573e", "#c25239", "#cf5f45"]);
        if (y % 4 === 3) c = "#94392a";
        else if (local === 0) c = "#a8452f";
        else if (y % 4 === 0) c = "#de7660";
        px(x, y, c);
      }
    }
  });
  t.snow = speckle(23, SNOW);
  t.snowSide = paint(24, ({ px, rnd, pick }) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, pick(STONE));
    for (let x = 0; x < 16; x++) {
      const depth = 4 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.2 ? 2 : 0);
      for (let y = 0; y < depth; y++) px(x, y, pick(SNOW));
    }
  });
  return t;
}

/** An isometric cube drawn from three face canvases, for the hotbar. */
export function drawCubeIcon(canvas, top, left, right) {
  const ctx = canvas.getContext("2d");
  const s = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, s, s);
  ctx.imageSmoothingEnabled = false;
  const r = s * 0.42;
  const w = r * 0.866;
  const cx = s / 2;
  const cy = s / 2 + r * 0.04;
  const face = (img, ox, oy, ux, uy, vx, vy, shade) => {
    ctx.save();
    ctx.setTransform(ux / 16, uy / 16, vx / 16, vy / 16, ox, oy);
    ctx.drawImage(img, 0, 0);
    if (shade) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(0,0,0,${shade})`;
      ctx.fillRect(0, 0, 16, 16);
    }
    ctx.restore();
  };
  face(left, cx - w, cy - r / 2, w, r / 2, 0, r, 0.16);
  face(right, cx, cy, w, -r / 2, 0, r, 0.32);
  face(top, cx, cy - r, w, r / 2, -w, r / 2, 0);
}
