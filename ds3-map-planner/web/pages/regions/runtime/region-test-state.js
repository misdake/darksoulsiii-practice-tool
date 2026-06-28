export function shouldRecordTestMissing({
  stage,
  stage4Mode,
  enabled,
  mode,
  playerReady,
  paused,
  activeRegions,
}) {
  return (
    Number(stage) === 4 &&
    stage4Mode === "test" &&
    Boolean(enabled) &&
    mode === "thirdPerson" &&
    Boolean(playerReady) &&
    !paused &&
    Array.isArray(activeRegions) &&
    activeRegions.length === 0
  );
}
