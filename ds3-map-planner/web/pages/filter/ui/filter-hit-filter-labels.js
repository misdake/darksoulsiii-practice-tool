const HIT_FILTER_TYPE_LABELS = new Map([
  [0, "Standard: No High Collision - No Foot IK"],
  [1, "Standard: No High Collision"],
  [2, "Standard: No High Collision"],
  [3, "Standard: No High Collision"],
  [4, "Standard: No High Collision"],
  [5, "Standard: No High Collision"],
  [6, "Standard: No High Collision"],
  [7, "Standard: No High Collision"],
  [8, "Collide with all characters"],
  [9, "Collide with camera only"],
  [11, "Collide with non-player characters only"],
  [13, "Trigger fall death camera in collision"],
  [14, "Trigger fall death camera in collision"],
  [15, "Trigger instant death on collision"],
  [16, "Type 16"],
  [17, "Type 17"],
  [19, "Collide with non-player characters only"],
  [20, "Type 20"],
  [21, "Slide movement"],
  [22, "Block all fall damage"],
  [23, "Type 23"],
  [24, "Type 24"],
  [29, "Type 29"],
]);

export function getHitFilterTypeLabel(hitFilterId, sampleObj = null) {
  if (HIT_FILTER_TYPE_LABELS.has(hitFilterId)) {
    return HIT_FILTER_TYPE_LABELS.get(hitFilterId);
  }

  const metadataLabel = String(
    sampleObj?.userData?.meta?.msbHitFilterType || "",
  ).trim();
  return metadataLabel || "Unknown";
}
