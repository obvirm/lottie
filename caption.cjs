//
// SRT gets split per word or per letter, each gets a copy of the template animation
// but the timing gets remapped to match each word's own duration
// template is just a visual pattern  -  the SRT calls the shots
//
// think of it like a rubber stamp  -  same shape, different timing per word

const fs = require("fs");
const path = require("path");

// make sure public/ exists before writing
fs.mkdirSync("public", { recursive: true });

// load config, template, and SRT from disk
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
var templatePath = config.active_template;
var template = null;
if (templatePath.includes("/") || templatePath.includes("\\")) {
  template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
} else {
  try {
    template = JSON.parse(fs.readFileSync("templates/" + templatePath, "utf8"));
  } catch (e) {
    template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  }
}
var srtFile = config.srt_file || "dummy.srt";
var srtText = fs.readFileSync(srtFile, "utf8");

const FPS = template.fr || 60;
const CANVAS_W = template.w || 512;
const CANVAS_H = template.h || 512;

// deep clone  -  break all references

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// turn SRT timestamp into frame number

function timeToFrames(timeStr) {
  const [time, ms] = timeStr.split(",");
  const [h, m, s] = time.split(":").map(Number);
  return Math.round((h * 3600 + m * 60 + s + Number(ms) / 1000) * FPS);
}

// PHASE 1: parse SRT -> split into words/letters -> group

const groups = [];
const allElements = []; // flat array for reference
const blocks = srtText.trim().split(/\r?\n\r?\n/);
const maxPerGroup = config.max_words_per_page || 1;

blocks.forEach((block) => {
  const lines = block.split(/\r?\n/);
  if (lines.length < 3) return;

  const [start, end] = lines[1].split(" --> ");
  const rawText = lines.slice(2).join(" ").toUpperCase();

  const blockStart = timeToFrames(start);
  const blockEnd = timeToFrames(end);

  const splitMode = config.split_mode || "word";
  let parts;
  if (splitMode === "letter") {
    parts = rawText.replace(/\s+/g, "").split("");
  } else {
    parts = rawText.split(/\s+/);
  }

  const blockDuration = blockEnd - blockStart;
  const framePerPart = Math.floor(blockDuration / parts.length);

  const blockElements = [];
  parts.forEach((part, idx) => {
    blockElements.push({
      text: part,
      startFrame: blockStart + idx * framePerPart,
      endFrame:
        idx === parts.length - 1
          ? blockEnd
          : blockStart + (idx + 1) * framePerPart,
    });
  });

  // group within each block  -  no cross-block mixing
  for (let i = 0; i < blockElements.length; i += maxPerGroup) {
    groups.push(blockElements.slice(i, i + maxPerGroup));
  }

  // flat list for calculating the total frame range
  allElements.push(...blockElements);
});

if (allElements.length === 0) {
  console.error("FATAL: Tidak ada element SRT yang valid!");
  process.exit(1);
}

// PHASE 2: read the template animation pattern

const textPatterns = template.layers.filter((l) => l.ty === 5);
const shapePatterns = template.layers.filter(
  (l) => l.ty === 4 && l.nm !== "background",
);
const bgLayer = template.layers.find((l) => l.nm === "background");

if (textPatterns.length === 0) {
  console.error("FATAL: Template harus punya minimal 1 text layer!");
  process.exit(1);
}

// the template ip/op defines one full animation cycle  -  used for remapping
const TPL_IP = textPatterns[0].ip;
const TPL_OP = textPatterns[0].op;
const TPL_DUR = TPL_OP - TPL_IP;

// text-to-box offset, computed in Phase 4 once FONT_SIZE is known
let textOffsetX = 0;
let textOffsetY = 0;

// PHASE 3: remap keyframes from template timeline to each element's timeline

function remapKeyframes(keyframes, elemStart, elemEnd) {
  if (!keyframes || !Array.isArray(keyframes) || keyframes.length === 0)
    return keyframes;
  if (typeof keyframes[0] !== "object" || !("t" in keyframes[0])) {
    return keyframes;
  }
  return keyframes.map((kf) => {
    const n = clone(kf);
    if (TPL_DUR === 0) {
      n.t = elemStart;
    } else {
      const relProgress = (kf.t - TPL_IP) / TPL_DUR;
      n.t = Math.round(elemStart + relProgress * (elemEnd - elemStart));
    }
    return n;
  });
}

function remapTransform(ks, elemStart, elemEnd) {
  const n = clone(ks);
  for (const prop of ["p", "s", "r", "o"]) {
    if (n[prop] && n[prop].a === 1 && Array.isArray(n[prop].k)) {
      n[prop].k = remapKeyframes(n[prop].k, elemStart, elemEnd);
    }
  }
  return n;
}

function remapTextData(td, elemStart, elemEnd) {
  const n = clone(td);
  if (n.d && n.d.k) {
    n.d.k = n.d.k.map((kf) => {
      const nk = clone(kf);
      if (TPL_DUR === 0) {
        nk.t = elemStart;
      } else {
        const rel = (kf.t - TPL_IP) / TPL_DUR;
        nk.t = Math.round(elemStart + rel * (elemEnd - elemStart));
      }
      return nk;
    });
  }
  return n;
}

function remapShapeItems(items, elemStart, elemEnd) {
  return items.map((item) => {
    const n = clone(item);
    if (n.ty === "rc") {
      if (n.s && n.s.a === 1) n.s.k = remapKeyframes(n.s.k, elemStart, elemEnd);
      if (n.p && n.p.a === 1) n.p.k = remapKeyframes(n.p.k, elemStart, elemEnd);
      if (n.r && n.r.a === 1) n.r.k = remapKeyframes(n.r.k, elemStart, elemEnd);
    }
    if (n.ty === "fl") {
      if (n.c && n.c.a === 1) n.c.k = remapKeyframes(n.c.k, elemStart, elemEnd);
      if (n.o && n.o.a === 1) n.o.k = remapKeyframes(n.o.k, elemStart, elemEnd);
    }
    return n;
  });
}

const finalLayers = [];
const baseX =
  config.position && config.position.x != null
    ? config.position.x
    : CANVAS_W / 2;
const baseY =
  config.position && config.position.y != null
    ? config.position.y
    : CANVAS_H / 2;
const GAP = config.word_gap ?? 16;
// font size: config overrides template default
const FONT_SIZE = config.font_size ?? (textPatterns[0].t.d.k[0].s.s || 50);
// box height: config first, fallback to template
let defaultBoxH = Math.max(FONT_SIZE * 1.4, 70);
if (shapePatterns.length > 0 && shapePatterns[0].shapes?.[0]?.it) {
  const rcItem = shapePatterns[0].shapes[0].it.find(function (i) {
    return i.ty === "rc";
  });
  if (rcItem && rcItem.s && rcItem.s.a === 0) {
    defaultBoxH = rcItem.s.k[1] || defaultBoxH;
  }
}
const BOX_HEIGHT = config.box_height ?? defaultBoxH;

// Calculate textOffsetX/Y � proportional to font_size
textOffsetX = 0;
if (shapePatterns.length > 0 && textPatterns.length > 0) {
  var tplBoxX, tplBoxY, tplTextX, tplTextY;
  if (shapePatterns[0].ks.p.a === 1) {
    var lastBox = shapePatterns[0].ks.p.k[shapePatterns[0].ks.p.k.length - 1];
    tplBoxX = lastBox.s[0];
    tplBoxY = lastBox.s[1];
  } else {
    tplBoxX = shapePatterns[0].ks.p.k[0];
    tplBoxY = shapePatterns[0].ks.p.k[1];
  }
  if (textPatterns[0].ks.p.a === 1) {
    var lastText = textPatterns[0].ks.p.k[textPatterns[0].ks.p.k.length - 1];
    tplTextX = lastText.s[0];
    tplTextY = lastText.s[1];
  } else {
    tplTextX = textPatterns[0].ks.p.k[0];
    tplTextY = textPatterns[0].ks.p.k[1];
  }
  textOffsetX = tplTextX - tplBoxX;
  var tplFontSize = textPatterns[0].t.d.k[0].s.s || 50;
  var tplOffsetY = tplTextY - tplBoxY;
  textOffsetY = Math.round((FONT_SIZE / tplFontSize) * tplOffsetY);
} else {
  textOffsetY = Math.round(FONT_SIZE * 0.4);
}

function estimateWordWidth(text) {
  return Math.max(text.length * FONT_SIZE * 0.55 + 40, 60);
}

let globalElementIdx = 0;

groups.forEach((group) => {
  const groupStart = group[0].startFrame;
  const groupEnd = group[group.length - 1].endFrame;

  group.forEach((el) => {
    el.width = estimateWordWidth(el.text);
  });
  const totalWidth =
    group.reduce((sum, el) => sum + el.width, 0) + (group.length - 1) * GAP;

  let currentX = baseX - totalWidth / 2;
  group.forEach((el) => {
    el.centerX = Math.round(currentX + el.width / 2);
    el.boxWidth = el.width;
    currentX += el.width + GAP;
  });

  group.forEach((el, ei) => {
    const patIdx = globalElementIdx % textPatterns.length;

    const srcText = textPatterns[patIdx];
    const textLayer = clone(srcText);

    textLayer.nm = "Word " + globalElementIdx + " - " + el.text;
    textLayer.ip = el.startFrame;
    textLayer.op = el.endFrame;
    textLayer.st = el.startFrame;

    textLayer.t = remapTextData(srcText.t, el.startFrame, el.endFrame);
    textLayer.t.d.k[0].s.t = el.text;
    // force font size from config (overrides template)
    textLayer.t.d.k[0].s.s = FONT_SIZE;
    textLayer.t.d.k[0].s.lh = FONT_SIZE; // line height follows
    textLayer.ks = remapTransform(srcText.ks, el.startFrame, el.endFrame);

    if (textLayer.ks.p.a === 0) {
      textLayer.ks.p.k = [el.centerX + textOffsetX, baseY + textOffsetY, 0];
    } else {
      const tplCenterX = CANVAS_W / 2;
      const tplCenterY = CANVAS_H / 2;
      textLayer.ks.p.k = textLayer.ks.p.k.map((kf) => {
        const n = clone(kf);
        if (Array.isArray(kf.s)) {
          n.s = [
            kf.s[0] - tplCenterX + el.centerX + textOffsetX,
            kf.s[1] - tplCenterY + baseY,
            kf.s[2] || 0,
          ];
        }
        return n;
      });
    }

    finalLayers.push(textLayer);

    if (shapePatterns.length > 0) {
      const spIdx = globalElementIdx % shapePatterns.length;
      const srcShape = shapePatterns[spIdx];

      const shapeLayer = clone(srcShape);
      shapeLayer.nm = "Box " + globalElementIdx + " - " + el.text;
      shapeLayer.ip = el.startFrame;
      shapeLayer.op = el.endFrame;
      shapeLayer.st = el.startFrame;

      shapeLayer.ks = remapTransform(srcShape.ks, el.startFrame, el.endFrame);

      if (shapeLayer.ks.p.a === 0) {
        shapeLayer.ks.p.k = [el.centerX, baseY, 0];
      } else {
        const tplCenterX = CANVAS_W / 2;
        const tplCenterY = CANVAS_H / 2;
        shapeLayer.ks.p.k = shapeLayer.ks.p.k.map((kf) => {
          const n = clone(kf);
          if (Array.isArray(kf.s)) {
            n.s = [
              kf.s[0] - tplCenterX + el.centerX,
              kf.s[1] - tplCenterY + baseY,
              kf.s[2] || 0,
            ];
          }
          return n;
        });
      }

      if (
        shapeLayer.shapes &&
        shapeLayer.shapes[0] &&
        shapeLayer.shapes[0].it
      ) {
        shapeLayer.shapes[0].it = remapShapeItems(
          srcShape.shapes[0].it,
          el.startFrame,
          el.endFrame,
        );

        shapeLayer.shapes[0].it.forEach((item) => {
          if (item.ty === "rc" && item.s && item.s.a === 0) {
            item.s.k = [el.boxWidth, BOX_HEIGHT];
          }
        });

        // color: config overrides template palette, which overrides template slot
        var colorPalette = null;
        var textPalette = null;
        if (config.colors) {
          colorPalette = config.colors.box || null;
          textPalette = config.colors.text || null;
        }
        if (!colorPalette && template._colors && template._colors.box) {
          colorPalette = template._colors.box;
        }
        if (!textPalette && template._colors && template._colors.text) {
          textPalette = template._colors.text;
        }
        // box color
        if (colorPalette && colorPalette.length > 0) {
          const color = colorPalette[ei % colorPalette.length];
          shapeLayer.shapes[0].it.forEach((item) => {
            if (item.ty === "fl" && item.c) {
              item.c.k = color;
              delete item.c.sid;
            }
          });
        }
        // text color
        if (textPalette && textPalette.length > 0) {
          const color = textPalette[ei % textPalette.length];
          textLayer.t.d.k[0].s.fc = color;
        }
      }

      finalLayers.push(shapeLayer);
    }

    globalElementIdx++;
  });
});

const maxFrame =
  allElements.length > 0
    ? Math.max(...allElements.map((e) => e.endFrame)) + 30
    : 60;

if (bgLayer) {
  bgLayer.op = maxFrame;
  finalLayers.push(bgLayer);
}

template.layers = finalLayers;
template.op = maxFrame;
template.ip = 0;

fs.writeFileSync("public/lottie.json", JSON.stringify(template, null, 2));

console.log("  " + config.active_template + " | " + allElements.length + " words | " + maxFrame + " frames (" + (maxFrame/FPS).toFixed(2) + "s)");
console.log("");
