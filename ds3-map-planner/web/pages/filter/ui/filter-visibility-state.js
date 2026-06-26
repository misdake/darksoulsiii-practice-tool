const EYE_VISIBLE_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
  </svg>
`;

const EYE_HIDDEN_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12s3.5-6 10-6c2.1 0 4 .6 5.5 1.5M22 12s-3.5 6-10 6c-2.1 0-4-.6-5.5-1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
  </svg>
`;

const EYE_PARTIAL_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <rect x="1" y="3" width="10" height="18" fill="currentColor" fill-opacity="0.2"/>
  </svg>
`;

export function visibleStateFor(objects) {
  const total = objects.length;
  const visibleCount = objects.reduce(
    (acc, obj) => acc + (obj.userData.manualEnabled !== false ? 1 : 0),
    0,
  );
  const state =
    visibleCount === 0
      ? "hidden"
      : visibleCount === total
        ? "visible"
        : "partial";

  return { total, visibleCount, state };
}

export function eyeSvgForState(state) {
  if (state === "visible") {
    return EYE_VISIBLE_SVG;
  }
  if (state === "hidden") {
    return EYE_HIDDEN_SVG;
  }
  return EYE_PARTIAL_SVG;
}

export function eyeTitleForState(state) {
  if (state === "visible") {
    return "Visible";
  }
  if (state === "hidden") {
    return "Hidden";
  }
  return "Partially visible";
}
