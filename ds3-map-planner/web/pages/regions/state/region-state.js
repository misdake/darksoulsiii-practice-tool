export class RegionState {
  constructor() {
    this.mapId = "";
    this.regions = [];
    this.selectedIndex = -1;
    this.editing = false;
    this.plans = [];
    this.missingPoints = new Map();
  }

  load({ mapId, regions, plans }) {
    this.mapId = mapId;
    this.regions = Array.isArray(regions) ? regions : [];
    this.plans = Array.isArray(plans) ? plans : [];
    this.selectedIndex = this.regions.length ? 0 : -1;
    this.editing = false;
    this.missingPoints.clear();
  }

  get selectedRegion() {
    return this.regions[this.selectedIndex] || null;
  }

  select(index) {
    this.selectedIndex = index >= 0 && index < this.regions.length ? index : -1;
    this.editing = false;
    return this.selectedRegion;
  }

  removeSelected() {
    if (this.selectedIndex < 0) return null;
    const [removed] = this.regions.splice(this.selectedIndex, 1);
    this.selectedIndex = Math.min(this.selectedIndex, this.regions.length - 1);
    this.editing = false;
    return removed || null;
  }

  replacePlan(plan) {
    this.plans = this.plans.filter(
      (item) => item.region_name !== plan.region_name,
    );
    this.plans.push(plan);
  }
}
