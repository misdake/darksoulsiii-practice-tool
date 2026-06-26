export function displayName(path) {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function extractBlockKey(path) {
  const name = displayName(path || "");
  const match = name.match(
    /^[hn](\d{2}_\d{2}_\d{2}_\d{2}_\d{6})(?:__.*|\.obj)$/i,
  );
  return match ? match[1] : "";
}
