export function loadedMapStatus({
  mapId,
  collisionGroup,
  navmeshGroup,
  failedCount,
}) {
  return [
    `loaded ${mapId}`,
    `collision: ${collisionGroup.children.length}`,
    `navmesh: ${navmeshGroup.children.length}`,
    `failed: ${failedCount}`,
  ].join("\n");
}

export function noStageDataStatus(stage) {
  return `${stage.name} has no data to save.`;
}
