#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const { exec } = require("child_process");

const HOST = process.env.PLANNER_HOST || "127.0.0.1";
const PORT = Number(process.env.PLANNER_PORT || 7878);
const DEFAULT_HIT_FILTER_IDS = [8];

const repoRoot = path.resolve(__dirname, "..");
const plannerRoot = path.join(repoRoot, "map-work", "capture-planner");
const webSourceRoot = path.join(__dirname, "web");
const webDistRoot = path.join(webSourceRoot, "dist");
const webRoot = fs.existsSync(webDistRoot) ? webDistRoot : webSourceRoot;
const mapWorkRoot = path.join(repoRoot, "map-work");

const MAP_DISPLAY_NAMES = {
  m21_00_00_00: "Base",
  m30_00_00_00: "High Wall of Lothric / Garden",
  m30_01_00_00: "Lothric Castle",
  m30_02_00_00: "Eclipsed Royal Castle 2",
  m31_00_00_00: "Undead Settlement",
  m31_02_00_00: "Spire Town (For Bake Test)",
  m32_00_00_00: "Archdragon Peak",
  m32_90_00_00: "Bridge For Bake Test",
  m33_00_00_00: "Road of Sacrifices / Farron Keep",
  m34_00_00_00: "Eclipsed Royal Castle 2",
  m34_01_00_00: "Grand Archives",
  m35_00_00_00: "Cathedral of the Deep",
  m36_00_00_00: "The Grave Of God",
  m36_90_00_00: "The Grave Of God 2",
  m37_00_00_00: "Irithyll / Anor Londo",
  m38_00_00_00: "Catacombs Carthus / Smouldering Lake",
  m39_00_00_00: "Dungeon / Profaned Capital",
  m40_00_00_00: "Cemetary / Firelink / Untended Graves",
  m41_00_00_00: "Kiln of Flame / Flameless Shrine",
  m45_00_00_00: "Painted World of Ariandel",
  m46_00_00_00: "Arena - Grand Roof",
  m47_00_00_00: "Arena - Kiln of Flame",
  m50_00_00_00: "Dreg Heap",
  m51_00_00_00: "Ringed City",
  m51_01_00_00: "Filianore's Rest",
  m53_00_00_00: "Arena - Dragon Ruins",
  m54_00_00_00: "Arena - Round Plaza",
};

function mapDisplayName(mapId) {
  return MAP_DISPLAY_NAMES[mapId] || mapId;
}

function isValidMapId(mapId) {
  return /^m\d{2}_\d{2}_\d{2}_\d{2}$/.test(mapId);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const text = JSON.stringify(obj, null, 2);
  sendText(res, status, text, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
}

function sendText(res, status, text, headers = {}) {
  const baseHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  res.writeHead(status, { ...baseHeaders, ...headers });
  res.end(text);
}

function noStoreHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

async function readJsonFile(filePath, what) {
  let text;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (e) {
    throw new Error(`failed to read ${what}: ${e.message}`);
  }
  const trimmed = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`failed to parse ${what}: ${e.message}`);
  }
}

function safeJoinInside(root, relPath) {
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, normalizedRel);
  const rootResolved = path.resolve(root);
  if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved)
    return null;
  return abs;
}

async function tryServeFile(res, absPath, explicitType = "") {
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(absPath).toLowerCase();
  const type =
    explicitType ||
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".obj": "text/plain; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
    }[ext] ||
    "application/octet-stream";
  const stream = fs.createReadStream(absPath);
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": type,
  });
  stream.pipe(res);
  return true;
}

async function getMaps() {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(plannerRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error(`failed to read planner root: ${e.message}`);
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const mapId = ent.name;
    if (!isValidMapId(mapId)) continue;
    const mapDir = path.join(plannerRoot, mapId);
    const collision = path.join(mapDir, "collision_world.json");
    const nav = path.join(mapDir, "navmesh_manifest.json");
    if (fs.existsSync(collision) && fs.existsSync(nav)) {
      out.push({ map_id: mapId, display_name: mapDisplayName(mapId) });
    }
  }
  out.sort((a, b) => a.map_id.localeCompare(b.map_id));
  return { maps: out };
}

async function getMapContent(mapId) {
  if (!isValidMapId(mapId)) throw new Error("invalid map_id");
  const mapDir = path.join(plannerRoot, mapId);
  let st;
  try {
    st = await fsp.stat(mapDir);
  } catch {
    throw new Error("map directory not found");
  }
  if (!st.isDirectory()) throw new Error("map directory not found");

  const collisionManifest = await readJsonFile(
    path.join(mapDir, "collision_world.json"),
    "collision manifest",
  );
  const navmeshManifest = await readJsonFile(
    path.join(mapDir, "navmesh_manifest.json"),
    "navmesh manifest",
  );
  const navmeshes = Array.isArray(navmeshManifest.navmeshes)
    ? navmeshManifest.navmeshes
    : [];
  for (const nav of navmeshes) {
    let replaced = String(nav.path || "");
    if (replaced.includes("/navmesh_objs/")) {
      replaced = replaced.replace("/navmesh_objs/", "/navmesh_objs_split/");
    } else if (replaced.includes("\\navmesh_objs\\")) {
      replaced = replaced.replace("\\navmesh_objs\\", "\\navmesh_objs_split\\");
    }
    nav.path = replaced;
  }

  return {
    map_id: mapId,
    default_hit_filter_ids: DEFAULT_HIT_FILTER_IDS.slice(),
    collision_manifest: collisionManifest,
    navmesh_manifest: navmeshManifest,
  };
}

const STAGE_FILES = Object.freeze({
  "stage1-collision-filter": "stage1_collision_filter.json",
  "stage2-nav-filter": "stage2_nav_filter.json",
  "stage3-mark-nav": "stage3_mark_nav.json",
  "stage4-map-regions": "stage4_map_regions.json",
  "stage6-map-region-shot-plans": "stage6_map_region_shot_plans.json",
});

async function getMapDir(mapId) {
  if (!isValidMapId(mapId)) throw new Error("invalid map_id");
  const mapDir = path.join(plannerRoot, mapId);
  let st;
  try {
    st = await fsp.stat(mapDir);
  } catch {
    throw new Error("map directory not found");
  }
  if (!st.isDirectory()) throw new Error("map directory not found");
  return mapDir;
}

async function loadStageData(mapId, stageName) {
  const fileName = STAGE_FILES[stageName];
  if (!fileName) throw new Error("invalid stage name");
  const mapDir = await getMapDir(mapId);
  const filePath = path.join(mapDir, fileName);
  if (!fs.existsSync(filePath)) return null;
  return await readJsonFile(filePath, stageName);
}

async function saveStageData(mapId, stageName, data) {
  const fileName = STAGE_FILES[stageName];
  if (!fileName) throw new Error("invalid stage name");
  const mapDir = await getMapDir(mapId);
  const text = JSON.stringify(data, null, 2);
  await fsp.writeFile(path.join(mapDir, fileName), text, "utf8");
}

function maybeOpenBrowser(url) {
  if (process.env.PLANNER_OPEN_BROWSER === "0") return;
  if (process.platform === "win32") {
    exec(`start "" "${url}"`);
  } else if (process.platform === "darwin") {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    sendText(res, 204, "");
    return;
  }

  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(u.pathname);

  try {
    if (req.method === "GET" && pathname === "/api/maps") {
      const maps = await getMaps();
      sendJson(res, 200, maps);
      return;
    }

    const mContent = pathname.match(/^\/api\/maps\/([^/]+)\/content$/);
    if (req.method === "GET" && mContent) {
      const out = await getMapContent(mContent[1]);
      sendJson(res, 200, out);
      return;
    }

    const mStage = pathname.match(
      /^\/api\/maps\/([^/]+)\/(stage1-collision-filter|stage2-nav-filter|stage3-mark-nav|stage4-map-regions|stage6-map-region-shot-plans)$/,
    );
    if (req.method === "GET" && mStage) {
      const data = await loadStageData(mStage[1], mStage[2]);
      if (data === null) sendJson(res, 404, { error: "stage data not found" });
      else sendJson(res, 200, data);
      return;
    }
    if (req.method === "PUT" && mStage) {
      const body = await readRequestJson(req);
      await saveStageData(mStage[1], mStage[2], body);
      sendText(res, 204, "");
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/" || pathname === "/index.html")
    ) {
      const p = path.join(webRoot, "index.html");
      const text = await fsp.readFile(p, "utf8");
      sendText(res, 200, text, noStoreHeaders("text/html; charset=utf-8"));
      return;
    }

    if (req.method === "GET" && pathname === "/app.js") {
      const p = path.join(webRoot, "app.js");
      const text = await fsp.readFile(p, "utf8");
      sendText(
        res,
        200,
        text,
        noStoreHeaders("text/javascript; charset=utf-8"),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/obj-worker.js") {
      const pDist = path.join(webRoot, "obj-worker.js");
      const pSource = path.join(webSourceRoot, "obj-worker.js");
      const p = fs.existsSync(pDist) ? pDist : pSource;
      const text = await fsp.readFile(p, "utf8");
      sendText(
        res,
        200,
        text,
        noStoreHeaders("text/javascript; charset=utf-8"),
      );
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/map-work/")) {
      const rel = pathname.slice("/map-work/".length);
      const abs = safeJoinInside(mapWorkRoot, rel);
      if (!abs) {
        sendJson(res, 400, { error: "invalid path" });
        return;
      }
      const ok = await tryServeFile(res, abs);
      if (!ok) sendText(res, 404, "not found");
      return;
    }

    if (req.method === "GET") {
      const rel = pathname.replace(/^\/+/, "");
      const abs = safeJoinInside(webRoot, rel || "index.html");
      if (!abs) {
        sendText(res, 404, "not found");
        return;
      }
      const ok = await tryServeFile(res, abs);
      if (ok) return;
      const maybeIndex = safeJoinInside(webRoot, path.join(rel, "index.html"));
      if (maybeIndex && (await tryServeFile(res, maybeIndex))) return;
      sendText(res, 404, "not found");
      return;
    }

    sendText(res, 405, "method not allowed");
  } catch (e) {
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) =>
    sendJson(res, 500, { error: e.message || String(e) }),
  );
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`Serving ${url}`);
  maybeOpenBrowser(url);
});
