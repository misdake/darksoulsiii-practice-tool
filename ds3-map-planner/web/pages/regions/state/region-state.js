export class RegionState {
  constructor() {
    this.mapId = "";
    this.regions = [];
    this.regionGroups = [];
    this.selectedIndex = -1;
    this.selectedIndices = [];
    this.plans = [];
  }

  load({ mapId, regions, regionGroups, plans }) {
    this.mapId = mapId;
    this.regions = Array.isArray(regions) ? regions : [];
    this.regionGroups = normalizeRegionGroups(this.regions, regionGroups);
    this.plans = Array.isArray(plans) ? plans : [];
    this.selectedIndex = this.regions.length ? 0 : -1;
    this.selectedIndices = this.selectedIndex >= 0 ? [this.selectedIndex] : [];
  }

  get selectedRegion() {
    return this.regions[this.selectedIndex] || null;
  }

  select(index) {
    this.selectedIndex = index >= 0 && index < this.regions.length ? index : -1;
    this.selectedIndices = this.selectedIndex >= 0 ? [this.selectedIndex] : [];
    return this.selectedRegion;
  }

  restoreSelection(indices, primaryIndex = indices.at(-1) ?? -1) {
    const valid = [...new Set(indices)].filter(
      (index) => index >= 0 && index < this.regions.length,
    );
    this.selectedIndices = valid;
    this.selectedIndex = valid.includes(primaryIndex)
      ? primaryIndex
      : valid.at(-1) ?? -1;
    return this.selectedRegion;
  }

  toggleSelected(index) {
    if (index < 0 || index >= this.regions.length) {
      return this.select(-1);
    }

    const selected = new Set(this.selectedIndices);
    if (selected.has(index)) {
      selected.delete(index);
    } else {
      selected.add(index);
    }

    this.selectedIndices = [...selected];
    this.selectedIndex = this.selectedIndices.at(-1) ?? -1;
    return this.selectedRegion;
  }

  removeSelected() {
    if (!this.selectedIndices.length) return [];
    const selected = new Set(this.selectedIndices);
    const removed = this.regions.filter((_, index) => selected.has(index));
    const firstIndex = Math.min(...this.selectedIndices);
    this.regions = this.regions.filter((_, index) => !selected.has(index));
    for (const region of removed) {
      this.regionGroups = removeRegionFromGroups(this.regionGroups, region.name);
    }
    this.selectedIndex = Math.min(firstIndex, this.regions.length - 1);
    this.selectedIndices = this.selectedIndex >= 0 ? [this.selectedIndex] : [];
    return removed;
  }

  renameRegion(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    this.regionGroups = this.regionGroups
      .map((group) => ({
        regions: group.regions.map((name) =>
          name === oldName ? newName : name,
        ),
      }))
      .filter((group) => group.regions.length > 1);
  }

  setRegions(regions) {
    this.regions = Array.isArray(regions) ? regions : [];
    this.regionGroups = normalizeRegionGroups(this.regions, this.regionGroups);
    if (this.selectedIndex >= this.regions.length) {
      this.selectedIndex = this.regions.length - 1;
    }
    this.selectedIndices = this.selectedIndices.filter(
      (index) => index >= 0 && index < this.regions.length,
    );
  }

  setRegionGroups(regionGroups) {
    this.regionGroups = normalizeRegionGroups(this.regions, regionGroups);
  }

  groupSelectedRegions() {
    const selectedNames = this.selectedIndices
      .map((index) => this.regions[index]?.name)
      .filter(Boolean);
    if (!selectedNames.length) {
      return false;
    }

    const selected = new Set(selectedNames);
    const remainingGroups = this.regionGroups
      .map((group) => ({
        regions: group.regions.filter((name) => !selected.has(name)),
      }))
      .filter((group) => group.regions.length > 1);

    const nextGroups =
      selectedNames.length > 1
        ? [...remainingGroups, { regions: selectedNames }]
        : remainingGroups;
    this.regionGroups = normalizeRegionGroups(this.regions, nextGroups);
    return true;
  }

  replacePlan(plan) {
    this.plans = this.plans.filter(
      (item) => item.region_name !== plan.region_name,
    );
    this.plans.push(plan);
  }
}

export function normalizeRegionGroups(regions, regionGroups = []) {
  const validNames = new Set(
    regions.map((region) => region?.name).filter(Boolean),
  );
  const used = new Set();
  const normalized = [];

  for (const group of Array.isArray(regionGroups) ? regionGroups : []) {
    const names = Array.isArray(group?.regions) ? group.regions : group;
    if (!Array.isArray(names)) continue;

    const groupNames = [];
    for (const name of names) {
      if (!validNames.has(name) || used.has(name)) continue;
      used.add(name);
      groupNames.push(name);
    }
    if (groupNames.length > 1) {
      normalized.push({ regions: groupNames });
    }
  }

  return normalized;
}

export function displayRegionGroups(regions, regionGroups = []) {
  const groupedNames = new Set(regionGroups.flatMap((group) => group.regions));
  const groups = [];

  for (const group of regionGroups) {
    const indices = group.regions
      .map((name) => regions.findIndex((region) => region.name === name))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    if (indices.length) groups.push(indices);
  }

  regions.forEach((region, index) => {
    if (!groupedNames.has(region.name)) {
      groups.push([index]);
    }
  });

  return groups.sort((a, b) => a[0] - b[0]);
}

export function regionGroupForIndex(regions, regionGroups, index) {
  const region = regions[index];
  if (!region) return [];
  const group = regionGroups.find((item) => item.regions.includes(region.name));
  if (!group) return [index];
  return group.regions
    .map((name) => regions.findIndex((candidate) => candidate.name === name))
    .filter((candidateIndex) => candidateIndex >= 0);
}

export function nextRegionName(regions) {
  const names = new Set(regions.map((region) => region.name));
  let index = 1;
  while (names.has(`Region ${index}`)) index += 1;
  return `Region ${index}`;
}

function removeRegionFromGroups(regionGroups, name) {
  if (!name) return regionGroups;
  return regionGroups
    .map((group) => ({
      regions: group.regions.filter((regionName) => regionName !== name),
    }))
    .filter((group) => group.regions.length > 1);
}
