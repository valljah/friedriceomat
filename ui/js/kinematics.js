// Kinematics of the 4-axis arm used by the 3D view, plus waypoint paths.
// Pure math (no DOM / WebGL) so it can be unit tested in Node.
//
// Frame: metres, y up, counter top at y = 0, arm base on the y axis.
// Joint chain: base yaw about y → shoulder pitch → elbow pitch → wrist pitch →
// tool of fixed length. Yaw φ points the arm along (cos φ, 0, −sin φ).
// Pitch angles are measured in the arm's vertical plane from the outward
// horizontal, positive upwards; a tool pitch of −π/2 points straight down.

export const ARM = { shoulderH: 0.36, l1: 0.42, l2: 0.38, tool: 0.13 };

export function inverseKinematics(tip, pitch, arm = ARM, prevYaw = 0) {
  const rho = Math.hypot(tip.x, tip.z);
  const yaw = rho > 1e-6 ? Math.atan2(-tip.z, tip.x) : prevYaw;
  // Wrist sits one tool length back along the tool direction, in the same
  // vertical plane as the tip.
  const wr = rho - arm.tool * Math.cos(pitch);
  const wy = tip.y - arm.tool * Math.sin(pitch);
  const dx = wr;
  const dy = wy - arm.shoulderH;
  const raw = Math.hypot(dx, dy);
  const minReach = Math.abs(arm.l1 - arm.l2) + 1e-6;
  const maxReach = arm.l1 + arm.l2 - 1e-6;
  const d = Math.min(maxReach, Math.max(minReach, raw));
  const base = Math.atan2(dy, dx);
  const cosOff = (arm.l1 * arm.l1 + d * d - arm.l2 * arm.l2) / (2 * arm.l1 * d);
  const off = Math.acos(Math.max(-1, Math.min(1, cosOff)));
  const q1 = base + off; // elbow-up solution
  const ex = arm.l1 * Math.cos(q1);
  const ey = arm.l1 * Math.sin(q1);
  // Wrist as reached (the requested point projected onto the reachable shell).
  const rx = d * Math.cos(base);
  const ry = d * Math.sin(base);
  const q2abs = Math.atan2(ry - ey, rx - ex);
  return {
    yaw,
    q1,
    q2: q2abs - q1,
    q3: pitch - q2abs,
    reachable: raw >= minReach && raw <= maxReach,
  };
}

export function forwardKinematics({ yaw, q1, q2, q3 }, arm = ARM) {
  const a1 = q1;
  const a2 = q1 + q2;
  const a3 = a2 + q3;
  const er = arm.l1 * Math.cos(a1);
  const ey = arm.shoulderH + arm.l1 * Math.sin(a1);
  const wr = er + arm.l2 * Math.cos(a2);
  const wy = ey + arm.l2 * Math.sin(a2);
  const tr = wr + arm.tool * Math.cos(a3);
  const ty = wy + arm.tool * Math.sin(a3);
  const world = (r, y) => ({ x: r * Math.cos(yaw), y, z: -r * Math.sin(yaw) });
  return {
    shoulder: world(0, arm.shoulderH),
    elbow: world(er, ey),
    wrist: world(wr, wy),
    tip: world(tr, ty),
    pitch: a3,
  };
}

// Waypoints are stored in cylindrical coordinates around the base
// { yaw, r, y, p } so that moves sweep around the arm instead of cutting
// through it. Extra keys (flags such as `grab`) are kept.
export function cyl(yawDeg, r, y, p, flags = {}) {
  return { yaw: (yawDeg * Math.PI) / 180, r, y, p, ...flags };
}

export function toCyl(pt) {
  return { yaw: Math.atan2(-pt.z, pt.x), r: Math.hypot(pt.x, pt.z), y: pt.y, p: pt.p };
}

export function fromCyl(c) {
  return { x: c.r * Math.cos(c.yaw), y: c.y, z: -c.r * Math.sin(c.yaw), p: c.p };
}

export function makePath(points) {
  const pts = points.map((p) => ({ ...p }));
  // Unwrap yaw so each move takes the short way round.
  for (let i = 1; i < pts.length; i++) {
    while (pts[i].yaw - pts[i - 1].yaw > Math.PI) pts[i].yaw -= 2 * Math.PI;
    while (pts[i].yaw - pts[i - 1].yaw < -Math.PI) pts[i].yaw += 2 * Math.PI;
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const arc = (b.yaw - a.yaw) * ((a.r + b.r) / 2);
    len.push(len[i - 1] + Math.hypot(arc, b.r - a.r, b.y - a.y) + 0.03);
  }
  return { pts, len, total: len[len.length - 1] || 1 };
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// Distance travelled along the path for an action progress in 0..1.
export function pathDistance(path, progress) {
  return smooth(Math.min(1, Math.max(0, progress))) * path.total;
}

export function samplePath(path, progress) {
  const d = pathDistance(path, progress);
  const { pts, len } = path;
  if (pts.length === 1) return { ...pts[0] };
  let i = 1;
  while (i < len.length - 1 && len[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const t = smooth(Math.min(1, Math.max(0, (d - len[i - 1]) / ((len[i] - len[i - 1]) || 1))));
  return { yaw: lerp(a.yaw, b.yaw, t), r: lerp(a.r, b.r, t), y: lerp(a.y, b.y, t), p: lerp(a.p, b.p, t) };
}
