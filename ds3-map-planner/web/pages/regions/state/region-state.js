const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RegionState {
  constructor({ now = () => new Date().toISOString(), randomUUID = defaultRandomUUID } = {}) {
    this.mapId = "";
    this.regionGroups = [];
    this.selectedPrisms = [];
    this.primaryPrism = null;
    this.plans = [];
    this.planningTargetKey = "fallback";
    this.now = now;
    this.randomUUID = randomUUID;
  }

  load({ mapId, regionGroups, plans }) {
    if (!Array.isArray(regionGroups)) {
      throw new Error("Stage 4 data must contain region_groups[]. Old regions schema is not supported.");
    }
    this.mapId = mapId;
    this.regionGroups = regionGroups;
    this.plans = Array.isArray(plans) ? plans : [];
    this.planningTargetKey = this.regionGroups[0]
      ? `region_group:${this.regionGroups[0].uuid}`
      : "fallback";
    this.selectedPrisms = [];
    this.primaryPrism = null;
    const first = flattenPrisms(this.regionGroups)[0]?.prism || null;
    if (first) this.restorePrismSelection([first], first);
  }

  get regions() {
    return flattenPrisms(this.regionGroups).map(createLegacyRegionView);
  }

  get selectedRegion() {
    const descriptor = this.descriptorForPrism(this.primaryPrism);
    return descriptor ? createLegacyRegionView(descriptor) : null;
  }

  get selectedIndex() {
    return flattenPrisms(this.regionGroups).findIndex(({ prism }) => prism === this.primaryPrism);
  }

  get selectedIndices() {
    const selected = new Set(this.selectedPrisms);
    return flattenPrisms(this.regionGroups)
      .map(({ prism }, index) => selected.has(prism) ? index : -1)
      .filter((index) => index >= 0);
  }

  select(index) {
    const prism = flattenPrisms(this.regionGroups)[index]?.prism || null;
    this.restorePrismSelection(prism ? [prism] : [], prism);
    return this.selectedRegion;
  }

  restoreSelection(indices, primaryIndex = indices.at(-1) ?? -1) {
    const flattened = flattenPrisms(this.regionGroups);
    const prisms = [...new Set(indices)].map((index) => flattened[index]?.prism).filter(Boolean);
    return this.restorePrismSelection(prisms, flattened[primaryIndex]?.prism);
  }

  restorePrismSelection(prisms, primary = prisms.at(-1) || null) {
    const valid = new Set(flattenPrisms(this.regionGroups).map(({ prism }) => prism));
    this.selectedPrisms = [...new Set(prisms)].filter((prism) => valid.has(prism));
    this.primaryPrism = this.selectedPrisms.includes(primary)
      ? primary
      : this.selectedPrisms.at(-1) || null;
    return this.selectedRegion;
  }

  toggleSelected(index) {
    const prism = flattenPrisms(this.regionGroups)[index]?.prism;
    if (!prism) return this.select(-1);
    const selected = [...this.selectedPrisms];
    const selectedIndex = selected.indexOf(prism);
    if (selectedIndex >= 0) selected.splice(selectedIndex, 1);
    else selected.push(prism);
    return this.restorePrismSelection(selected, selected.at(-1) || null);
  }

  createGroup(prisms, name = nextRegionGroupName(this.regionGroups)) {
    const used = new Set(this.regionGroups.map((group) => group.uuid));
    let uuid;
    do uuid = this.randomUUID(); while (used.has(uuid));
    const group = {
      uuid,
      name,
      last_updated: this.now(),
      prisms,
    };
    this.regionGroups.push(group);
    return group;
  }

  touchGroup(group) {
    if (!group) return;
    const next = this.now();
    group.last_updated = next === group.last_updated
      ? new Date(Date.parse(next) + 1).toISOString()
      : next;
  }

  removeSelected() {
    if (!this.selectedPrisms.length) return [];
    const selected = new Set(this.selectedPrisms);
    const removed = [...this.selectedPrisms];
    const nextGroups = [];
    for (const group of this.regionGroups) {
      const prisms = group.prisms.filter((prism) => !selected.has(prism));
      if (prisms.length === group.prisms.length) {
        nextGroups.push(group);
      } else if (prisms.length) {
        group.prisms = prisms;
        this.touchGroup(group);
        nextGroups.push(group);
      }
    }
    this.regionGroups = nextGroups;
    this.restorePrismSelection([], null);
    return removed;
  }

  groupSelectedRegions() {
    if (!this.selectedPrisms.length) return false;
    const descriptors = this.selectedPrisms.map((prism) => this.descriptorForPrism(prism)).filter(Boolean);
    const anchor = descriptors[0]?.group;
    if (!anchor) return false;
    if (descriptors.every(({ group }) => group === anchor)) {
      if (descriptors.length !== 1 || anchor.prisms.length === 1) return false;
      const prism = descriptors[0].prism;
      anchor.prisms = anchor.prisms.filter((candidate) => candidate !== prism);
      this.touchGroup(anchor);
      const created = this.createGroup([prism]);
      this.restorePrismSelection([prism], prism);
      return Boolean(created);
    }

    const moving = descriptors.filter(({ group }) => group !== anchor);
    for (const { group, prism } of moving) {
      group.prisms = group.prisms.filter((candidate) => candidate !== prism);
      this.touchGroup(group);
    }
    anchor.prisms.push(...moving.map(({ prism }) => prism));
    this.touchGroup(anchor);
    this.regionGroups = this.regionGroups.filter((group) => group.prisms.length);
    this.restorePrismSelection(this.selectedPrisms, this.primaryPrism);
    return true;
  }

  splitSelectedHeight() {
    const descriptor = this.descriptorForPrism(this.primaryPrism);
    if (!descriptor) return null;
    const midpoint = (descriptor.prism.ymin + descriptor.prism.ymax) / 2;
    const upper = clonePrism(descriptor.prism);
    descriptor.prism.ymax = midpoint;
    upper.ymin = midpoint;
    this.touchGroup(descriptor.group);
    const upperGroup = this.createGroup([upper]);
    this.restorePrismSelection([upper], upper);
    return { lower: descriptor.prism, upper, upperGroup };
  }

  setRegions() {
    throw new Error("Set region groups instead of a flat regions array.");
  }

  setRegionGroups(regionGroups) {
    this.regionGroups = Array.isArray(regionGroups) ? regionGroups : [];
    this.reconcileSelection();
  }

  replacePlan(plan) {
    const key = planTargetKey(plan);
    this.plans = this.plans.filter((item) => planTargetKey(item) !== key);
    this.plans.push(plan);
  }

  descriptorForPrism(prism) {
    return flattenPrisms(this.regionGroups).find((item) => item.prism === prism) || null;
  }

  reconcileSelection() {
    return this.restorePrismSelection(this.selectedPrisms, this.primaryPrism);
  }
}

export function flattenPrisms(regionGroups = []) {
  const flattened = [];
  regionGroups.forEach((group, groupIndex) => {
    group.prisms.forEach((prism, prismIndex) => {
      flattened.push({ group, groupIndex, groupUuid: group.uuid, prism, prismIndex });
    });
  });
  return flattened;
}

export function nextRegionGroupName(groups) {
  const names = new Set(groups.map((group) => group.name));
  let index = 1;
  while (names.has(`Region Group ${index}`)) index += 1;
  return `Region Group ${index}`;
}

export function regionGroupForIndex(_regions, groups, index) {
  const descriptor = flattenPrisms(groups)[index];
  if (!descriptor) return [];
  return flattenPrisms(groups)
    .map((candidate, candidateIndex) => candidate.group === descriptor.group ? candidateIndex : -1)
    .filter((candidateIndex) => candidateIndex >= 0);
}

export function planTargetKey(plan) {
  return plan?.kind === "fallback" ? "fallback" : `region_group:${plan?.region_group_uuid || ""}`;
}

export function isValidUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function createLegacyRegionView(descriptor) {
  const view = { prism: descriptor.prism, group: descriptor.group, groupUuid: descriptor.group.uuid };
  for (const key of ["ymin", "ymax", "polygon_xz"]) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => descriptor.prism[key],
      set: (value) => { descriptor.prism[key] = value; },
    });
  }
  Object.defineProperty(view, "name", {
    enumerable: true,
    get: () => descriptor.group.name,
    set: (value) => { descriptor.group.name = value; },
  });
  return view;
}

function clonePrism(prism) {
  return {
    ymin: prism.ymin,
    ymax: prism.ymax,
    polygon_xz: prism.polygon_xz.map(([x, z]) => [x, z]),
  };
}

function defaultRandomUUID() {
  return crypto.randomUUID();
}
