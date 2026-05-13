pub fn point_in_polygon(x: f32, z: f32, poly: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let xi = poly[i][0];
        let zi = poly[i][1];
        let xj = poly[j][0];
        let zj = poly[j][1];
        let intersect =
            ((zi > z) != (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1.0e-12) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn dist2_point_seg(px: f32, pz: f32, ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
    let abx = bx - ax;
    let abz = bz - az;
    let apx = px - ax;
    let apz = pz - az;
    let d = abx * abx + abz * abz;
    if d <= 1.0e-12 {
        return apx * apx + apz * apz;
    }
    let t = ((apx * abx + apz * abz) / d).clamp(0.0, 1.0);
    let qx = ax + t * abx;
    let qz = az + t * abz;
    let dx = px - qx;
    let dz = pz - qz;
    dx * dx + dz * dz
}
