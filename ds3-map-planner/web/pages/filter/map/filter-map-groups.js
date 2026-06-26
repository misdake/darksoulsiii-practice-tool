export function detachFilterMapGroups(root, collisionGroup, navmeshGroup) {
  if (collisionGroup) root.remove(collisionGroup);
  if (navmeshGroup) root.remove(navmeshGroup);
}

export function rebuildFilterObjectMenus({
  objectListController,
  collisionGroup,
  navmeshGroup,
}) {
  objectListController.rebuildObjectMenu(collisionGroup, navmeshGroup);
  objectListController.rebuildHitFilterMenu(collisionGroup);
}
