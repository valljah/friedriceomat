// Minimal WebGL renderer: column-major 4×4 matrices, a few mesh builders and
// one Blinn-Phong shader (hemisphere ambient + key light + point light).
// Just enough for the robot cell, with no external dependencies.

// ------------------------------------------------------------- matrices --

export const mat4 = {
  identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  },
  // mul(a, b, c, ...) = a · b · c · ...
  mul(...ms) {
    return ms.reduce((acc, m) => mat4.multiply(acc, m));
  },
  translation(x, y, z) {
    const m = mat4.identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  },
  scaling(x, y = x, z = x) {
    const m = mat4.identity();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
  },
  rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  },
  rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  },
  rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  },
  lookAt(eye, center, up) {
    const z = norm(sub(eye, center));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
  },
  // Maps a unit shape centred on the origin and aligned with +y (height 1)
  // onto the segment from → to with the given radius.
  alignY(from, to, radius) {
    const d = sub(to, from);
    const len = Math.hypot(d[0], d[1], d[2]) || 1e-6;
    const u = [d[0] / len, d[1] / len, d[2] / len];
    const ref = Math.abs(u[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
    const x = norm(cross(u, ref));
    const z = cross(x, u);
    return new Float32Array([
      x[0] * radius, x[1] * radius, x[2] * radius, 0,
      d[0], d[1], d[2], 0,
      z[0] * radius, z[1] * radius, z[2] * radius, 0,
      (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2, 1,
    ]);
  },
  // Inverse-transpose of the upper 3×3 (normal matrix), column-major mat3.
  normalMatrix(m) {
    const a00 = m[0], a01 = m[4], a02 = m[8];
    const a10 = m[1], a11 = m[5], a12 = m[9];
    const a20 = m[2], a21 = m[6], a22 = m[10];
    const c00 = a11 * a22 - a12 * a21;
    const c01 = -(a10 * a22 - a12 * a20);
    const c02 = a10 * a21 - a11 * a20;
    const c10 = -(a01 * a22 - a02 * a21);
    const c11 = a00 * a22 - a02 * a20;
    const c12 = -(a00 * a21 - a01 * a20);
    const c20 = a01 * a12 - a02 * a11;
    const c21 = -(a00 * a12 - a02 * a10);
    const c22 = a00 * a11 - a01 * a10;
    const det = a00 * c00 + a01 * c01 + a02 * c02 || 1e-9;
    // out[col * 3 + row] = C[row][col] / det
    return new Float32Array([
      c00 / det, c10 / det, c20 / det,
      c01 / det, c11 / det, c21 / det,
      c02 / det, c12 / det, c22 / det,
    ]);
  },
  // Inverse of a rigid transform (rotation + translation only).
  invertRigid(m) {
    const out = new Float32Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
    out[15] = 1;
    return out;
  },
  transformPoint(m, p) {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
      w,
    ];
  },
};

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// "#rrggbb" or "rgb(r, g, b)" → [r, g, b] in 0..1
export function rgb(color) {
  const c = (color || '').trim();
  if (c.startsWith('#')) {
    const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return [r / 255, g / 255, b / 255];
  }
  return [0.5, 0.5, 0.5];
}

// --------------------------------------------------------------- meshes --
// All builders return { positions, normals, indices } for unit-sized shapes.

export const geometry = {
  box() {
    const P = [];
    const N = [];
    const I = [];
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [n, u, v] of faces) {
      const base = P.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        P.push(0.5 * (n[0] + su * u[0] + sv * v[0]), 0.5 * (n[1] + su * u[1] + sv * v[1]), 0.5 * (n[2] + su * u[2] + sv * v[2]));
        N.push(...n);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { positions: P, normals: N, indices: I };
  },

  // Radius 1 at the bottom (rBottom) / top (rTop), height 1, centred on the origin.
  cylinder(rTop = 1, rBottom = 1, seg = 24, caps = true) {
    const P = [];
    const N = [];
    const I = [];
    const slope = rBottom - rTop;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const n = norm([c, slope, s]);
      P.push(c * rBottom, -0.5, s * rBottom, c * rTop, 0.5, s * rTop);
      N.push(...n, ...n);
    }
    for (let i = 0; i < seg; i++) {
      const k = i * 2;
      I.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
    if (caps) {
      for (const [y, r, ny] of [[0.5, rTop, 1], [-0.5, rBottom, -1]]) {
        if (r <= 0) continue;
        const center = P.length / 3;
        P.push(0, y, 0);
        N.push(0, ny, 0);
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          P.push(Math.cos(a) * r, y, Math.sin(a) * r);
          N.push(0, ny, 0);
        }
        for (let i = 0; i < seg; i++) I.push(center, center + 1 + i, center + 2 + i);
      }
    }
    return { positions: P, normals: N, indices: I };
  },

  sphere(wSeg = 16, hSeg = 12) {
    const P = [];
    const N = [];
    const I = [];
    for (let j = 0; j <= hSeg; j++) {
      const v = (j / hSeg) * Math.PI;
      for (let i = 0; i <= wSeg; i++) {
        const u = (i / wSeg) * Math.PI * 2;
        const n = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
        P.push(...n);
        N.push(...n);
      }
    }
    for (let j = 0; j < hSeg; j++) {
      for (let i = 0; i < wSeg; i++) {
        const a = j * (wSeg + 1) + i;
        const b = a + wSeg + 1;
        I.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { positions: P, normals: N, indices: I };
  },

  // Surface of revolution around y from a profile of [radius, y] points.
  lathe(profile, seg = 32) {
    const P = [];
    const N = [];
    const I = [];
    const n2 = profile.map((p, i) => {
      const a = profile[Math.max(0, i - 1)];
      const b = profile[Math.min(profile.length - 1, i + 1)];
      const t = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(t[0], t[1]) || 1;
      return [t[1] / l, -t[0] / l];
    });
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      profile.forEach(([r, y], k) => {
        P.push(c * r, y, s * r);
        N.push(c * n2[k][0], n2[k][1], s * n2[k][0]);
      });
    }
    const m = profile.length;
    for (let i = 0; i < seg; i++) {
      for (let k = 0; k < m - 1; k++) {
        const a = i * m + k;
        const b = (i + 1) * m + k;
        I.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { positions: P, normals: N, indices: I };
  },

  torus(tube = 0.08, seg = 32, tubeSeg = 8) {
    const P = [];
    const N = [];
    const I = [];
    for (let i = 0; i <= seg; i++) {
      const u = (i / seg) * Math.PI * 2;
      for (let j = 0; j <= tubeSeg; j++) {
        const v = (j / tubeSeg) * Math.PI * 2;
        const n = [Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)];
        P.push(Math.cos(u) + tube * n[0], tube * n[1], Math.sin(u) + tube * n[2]);
        N.push(...n);
      }
    }
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < tubeSeg; j++) {
        const a = i * (tubeSeg + 1) + j;
        const b = a + tubeSeg + 1;
        I.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { positions: P, normals: N, indices: I };
  },

  // Unit quad in the xy plane, for camera-facing sprites.
  quad() {
    return {
      positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
  },
};

// ------------------------------------------------------------- renderer --

const VS = `
attribute vec3 a_pos;
attribute vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform mat3 u_normalMat;
varying vec3 v_world;
varying vec3 v_normal;
varying vec3 v_local;
void main() {
  vec4 w = u_model * vec4(a_pos, 1.0);
  v_world = w.xyz;
  v_normal = u_normalMat * a_normal;
  v_local = a_pos;
  gl_Position = u_viewProj * w;
}`;

const FS = `
precision mediump float;
uniform vec3 u_color;
uniform vec3 u_emissive;
uniform vec3 u_camPos;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform vec3 u_sky;
uniform vec3 u_ground;
uniform vec3 u_pointPos;
uniform vec3 u_pointColor;
uniform float u_opacity;
uniform float u_shininess;
uniform float u_unlit;
uniform float u_disc;
varying vec3 v_world;
varying vec3 v_normal;
varying vec3 v_local;
void main() {
  float alpha = u_opacity;
  if (u_disc > 0.5) alpha *= 1.0 - smoothstep(0.25, 1.0, length(v_local.xy) * 2.0);
  if (u_unlit > 0.5) {
    gl_FragColor = vec4(u_color + u_emissive, alpha);
    return;
  }
  vec3 n = normalize(v_normal);
  vec3 v = normalize(u_camPos - v_world);
  if (dot(n, v) < 0.0) n = -n; // two-sided lighting
  vec3 l = normalize(u_lightDir);
  float diff = max(dot(n, l), 0.0);
  vec3 h = normalize(l + v);
  float spec = u_shininess > 1.0 ? pow(max(dot(n, h), 0.0), u_shininess) : 0.0;
  vec3 amb = mix(u_ground, u_sky, n.y * 0.5 + 0.5);
  vec3 pl = u_pointPos - v_world;
  float pd = length(pl);
  float pdiff = max(dot(n, pl / max(pd, 1e-4)), 0.0) / (1.0 + pd * pd * 30.0);
  vec3 col = u_color * (amb + u_lightColor * diff + u_pointColor * pdiff) + u_lightColor * spec * 0.35 + u_emissive;
  gl_FragColor = vec4(col, alpha);
}`;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.program = this.link(VS, FS);
    gl.useProgram(this.program);
    this.attr = {
      pos: gl.getAttribLocation(this.program, 'a_pos'),
      normal: gl.getAttribLocation(this.program, 'a_normal'),
    };
    this.u = {};
    for (const name of ['model', 'viewProj', 'normalMat', 'color', 'emissive', 'camPos', 'lightDir', 'lightColor',
      'sky', 'ground', 'pointPos', 'pointColor', 'opacity', 'shininess', 'unlit', 'disc']) {
      this.u[name] = gl.getUniformLocation(this.program, `u_${name}`);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.queue = [];
  }

  link(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  mesh({ positions, normals, indices }) {
    const gl = this.gl;
    if (positions.length / 3 > 65535) throw new Error('Mesh too large for 16-bit indices');
    const buf = (target, data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    return {
      pos: buf(gl.ARRAY_BUFFER, new Float32Array(positions)),
      normal: buf(gl.ARRAY_BUFFER, new Float32Array(normals)),
      index: buf(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices)),
      count: indices.length,
    };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { width: r.width, height: r.height };
  }

  // Queue a draw. material: { color, emissive?, opacity?, shininess?, unlit?, disc? }
  draw(mesh, model, material) {
    this.queue.push({ mesh, model, material });
  }

  // Draws all queued meshes: opaque first, then transparent back-to-front.
  render(scene) {
    const { gl, u } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.viewProj, false, scene.viewProj);
    gl.uniform3fv(u.camPos, scene.camPos);
    gl.uniform3fv(u.lightDir, scene.lightDir);
    gl.uniform3fv(u.lightColor, scene.lightColor);
    gl.uniform3fv(u.sky, scene.sky);
    gl.uniform3fv(u.ground, scene.ground);
    gl.uniform3fv(u.pointPos, scene.pointPos);
    gl.uniform3fv(u.pointColor, scene.pointColor);

    const opaque = [];
    const transparent = [];
    for (const item of this.queue) ((item.material.opacity ?? 1) < 1 ? transparent : opaque).push(item);
    const camDist = (m) => Math.hypot(m[12] - scene.camPos[0], m[13] - scene.camPos[1], m[14] - scene.camPos[2]);
    transparent.sort((a, b) => camDist(b.model) - camDist(a.model));

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const item of opaque) this.drawItem(item);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const item of transparent) this.drawItem(item);
    gl.depthMask(true);
    this.queue = [];
  }

  drawItem({ mesh, model, material }) {
    const { gl, u, attr } = this;
    gl.uniformMatrix4fv(u.model, false, model);
    gl.uniformMatrix3fv(u.normalMat, false, mat4.normalMatrix(model));
    gl.uniform3fv(u.color, material.color);
    gl.uniform3fv(u.emissive, material.emissive ?? [0, 0, 0]);
    gl.uniform1f(u.opacity, material.opacity ?? 1);
    gl.uniform1f(u.shininess, material.shininess ?? 0);
    gl.uniform1f(u.unlit, material.unlit ? 1 : 0);
    gl.uniform1f(u.disc, material.disc ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
    gl.enableVertexAttribArray(attr.pos);
    gl.vertexAttribPointer(attr.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
    gl.enableVertexAttribArray(attr.normal);
    gl.vertexAttribPointer(attr.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }
}
