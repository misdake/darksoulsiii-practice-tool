function parseObjText(text) {
  const verts = [];
  const indices = [];

  const lines = text.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        verts.push(Number(p[1]), Number(p[2]), Number(p[3]));
      }
      continue;
    }
    if (line.startsWith("f ")) {
      const p = line.split(/\s+/);
      if (p.length < 4) continue;
      const face = [];
      for (let i = 1; i < p.length; i++) {
        const token = p[i];
        const slash = token.indexOf("/");
        const raw = slash >= 0 ? token.slice(0, slash) : token;
        const idx = Number(raw);
        if (!Number.isFinite(idx) || idx === 0) continue;
        const zeroBased = idx > 0 ? idx - 1 : (verts.length / 3 + idx);
        face.push(zeroBased);
      }
      for (let i = 1; i + 1 < face.length; i++) {
        const ia = face[0];
        const ib = face[i];
        const ic = face[i + 1];
        const vcount = verts.length / 3;
        if (ia < 0 || ib < 0 || ic < 0 || ia >= vcount || ib >= vcount || ic >= vcount) {
          continue;
        }
        indices.push(ia, ib, ic);
      }
    }
  }

  return {
    positions: new Float32Array(verts),
    indices: new Uint32Array(indices),
  };
}

self.onmessage = async (ev) => {
  const { id, path } = ev.data;
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch failed ${res.status}: ${path}`);
    const text = await res.text();
    const parsed = parseObjText(text);
    self.postMessage(
      {
        id,
        ok: true,
        positions: parsed.positions.buffer,
        indices: parsed.indices.buffer,
      },
      [parsed.positions.buffer, parsed.indices.buffer]
    );
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      error: e && e.message ? e.message : String(e),
    });
  }
};
