function parseObjText(text) {
  const vertices = [];
  const objects = [];
  let current = { name: "default", faces: [] };

  const pushCurrent = () => {
    if (current.faces.length > 0 || objects.length === 0) objects.push(current);
  };

  const lines = text.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      if (p.length >= 4) vertices.push(Number(p[1]), Number(p[2]), Number(p[3]));
      continue;
    }
    if (line.startsWith("o ") || line.startsWith("g ")) {
      pushCurrent();
      current = { name: line.slice(2).trim() || `obj_${objects.length}`, faces: [] };
      continue;
    }
    if (line.startsWith("f ")) {
      const p = line.split(/\s+/);
      if (p.length < 4) continue;
      const face = [];
      for (let i = 1; i < p.length; i++) {
        const token = p[i];
        const raw = token.split("/")[0];
        const idx = Number(raw);
        if (!Number.isFinite(idx) || idx === 0) continue;
        const zeroBased = idx > 0 ? idx - 1 : (vertices.length / 3 + idx);
        face.push(zeroBased);
      }
      for (let i = 1; i + 1 < face.length; i++) {
        current.faces.push([face[0], face[i], face[i + 1]]);
      }
    }
  }
  pushCurrent();

  const meshes = [];
  for (const obj of objects) {
    if (!obj.faces || obj.faces.length === 0) continue;
    const indexMap = new Map();
    const outPositions = [];
    const outIndices = [];
    const mapIndex = (vi) => {
      let mapped = indexMap.get(vi);
      if (mapped !== undefined) return mapped;
      const base = vi * 3;
      if (base < 0 || base + 2 >= vertices.length) return -1;
      mapped = outPositions.length / 3;
      outPositions.push(vertices[base], vertices[base + 1], vertices[base + 2]);
      indexMap.set(vi, mapped);
      return mapped;
    };
    for (const tri of obj.faces) {
      const a = mapIndex(tri[0]);
      const b = mapIndex(tri[1]);
      const c = mapIndex(tri[2]);
      if (a < 0 || b < 0 || c < 0) continue;
      if (a === b || b === c || a === c) continue;
      outIndices.push(a, b, c);
    }
    if (outIndices.length === 0) continue;
    meshes.push({ name: obj.name, positions: outPositions, indices: outIndices });
  }

  if (meshes.length === 0 && vertices.length > 0) {
    meshes.push({ name: "default", positions: vertices.slice(), indices: [] });
  }

  return { meshes };
}

self.onmessage = async (ev) => {
  const { id, path } = ev.data;
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`fetch failed ${res.status}: ${path}`);
    const text = await res.text();
    const parsed = parseObjText(text);
    const contentLengthHeader = res.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
    const downloadBytes = Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : new TextEncoder().encode(text).length;
    self.postMessage({ id, ok: true, meshes: parsed.meshes, downloadBytes });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e) });
  }
};
