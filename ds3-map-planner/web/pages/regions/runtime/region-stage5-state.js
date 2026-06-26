export function shouldRecordStage5Missing({
  stage,
  mode,
  playerReady,
  paused,
  activeRegions,
}) {
  return (
    Number(stage) === 5 &&
    mode === "thirdPerson" &&
    Boolean(playerReady) &&
    !paused &&
    Array.isArray(activeRegions) &&
    activeRegions.length === 0
  );
}
