import type { BunnyMood } from "./mood";
import { getBunnyPose } from "./motion";

export interface BunnyPuppetOptions {
  src: string;
  mood: BunnyMood;
  playing: boolean;
  petting?: boolean;
  reducedMotion?: boolean;
  onReady?: () => void;
  onError?: () => void;
}

export interface BunnyPuppet {
  update(options: Partial<BunnyPuppetOptions>): void;
  dispose(): void;
}

const VERTEX_SHADER = `
precision highp float;
attribute vec2 a_uv;
varying vec2 v_uv;
uniform vec4 u_root;
uniform vec4 u_head;
uniform vec4 u_expression;
uniform vec2 u_eye_left;
uniform vec2 u_eye_right;
uniform vec2 u_mouth;
uniform vec4 u_paws;
uniform vec2 u_contain;
uniform float u_blink_allowed;

vec2 rotate_at(vec2 position, vec2 pivot, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  vec2 relative = position - pivot;
  return pivot + vec2(c * relative.x - s * relative.y,
                      s * relative.x + c * relative.y);
}

float soft_area(vec2 point, vec2 center, vec2 radius) {
  vec2 distance = (point - center) / radius;
  return exp(-dot(distance, distance) * 2.2);
}

void main() {
  vec2 uv = a_uv;
  vec2 p = uv;

  // The same connected mesh carries the eyelids, cheeks and muzzle. No moving
  // image cutouts are stacked over the original face, so there are no seams.
  float eye_l = soft_area(uv, u_eye_left, vec2(0.095, 0.064));
  float eye_r = soft_area(uv, u_eye_right, vec2(0.095, 0.064));
  float blink = u_expression.z * u_blink_allowed * 0.97;
  p.y += (u_eye_left.y - uv.y) * eye_l * blink;
  p.y += (u_eye_right.y - uv.y) * eye_r * blink;
  float mouth_area = soft_area(uv, u_mouth, vec2(0.085, 0.066));
  p.y += (uv.y - u_mouth.y) * mouth_area * u_expression.w;

  float torso = smoothstep(0.55, 0.82, uv.y);
  p.y += (uv.y - 0.91) * u_root.w * torso;
  p.x += (uv.x - 0.50) * u_root.w * torso * 0.26;

  float left_paw = soft_area(uv, u_paws.xy, vec2(0.145, 0.14));
  float right_paw = soft_area(uv, u_paws.zw, vec2(0.145, 0.14));
  vec2 left_pivot = u_paws.xy + vec2(-0.018, -0.095);
  vec2 right_pivot = u_paws.zw + vec2(0.018, -0.095);
  p += (rotate_at(p, left_pivot, u_expression.x) - p) * left_paw;
  p += (rotate_at(p, right_pivot, u_expression.y) - p) * right_paw;

  float left_ear = (1.0 - smoothstep(0.28, 0.44, uv.y))
                 * (1.0 - smoothstep(0.36, 0.49, uv.x));
  float right_ear = (1.0 - smoothstep(0.31, 0.48, uv.y))
                  * smoothstep(0.54, 0.68, uv.x);
  p += (rotate_at(p, vec2(0.35, 0.28), u_head.z) - p) * left_ear;
  p += (rotate_at(p, vec2(0.73, 0.30), u_head.w) - p) * right_ear;

  float head = 1.0 - smoothstep(0.55, 0.69, uv.y);
  p += (rotate_at(p, vec2(0.50, 0.62), u_head.x) - p) * head;
  p.y += u_head.y * head;
  // A small depth-like squash makes the downward rock nod read as a nod,
  // rather than merely rotating the portrait from side to side.
  p.y += (uv.y - 0.62) * abs(u_head.x) * head * 0.22;

  p = rotate_at(p, vec2(0.50, 0.88), u_root.z);
  p += u_root.xy;
  vec2 centered = (p - 0.5) * u_contain;
  gl_Position = vec4(centered.x * 2.0, -centered.y * 2.0, 0.0, 1.0);
  v_uv = uv;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}
`;

function mesh(segments = 80) {
  const uv = new Float32Array((segments + 1) * (segments + 1) * 2);
  const indices = new Uint16Array(segments * segments * 6);
  let vertex = 0;
  let index = 0;
  for (let y = 0; y <= segments; y++) {
    for (let x = 0; x <= segments; x++) {
      uv[vertex++] = x / segments;
      uv[vertex++] = y / segments;
    }
  }
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices[index++] = a;
      indices[index++] = b;
      indices[index++] = c;
      indices[index++] = b;
      indices[index++] = d;
      indices[index++] = c;
    }
  }
  return { uv, indices };
}

/** A lightweight, connected 2D character rig; all coordinates refer to the
 * supplied square mascot artwork. It does not inspect or sample music audio. */
export function createBunnyPuppet(
  canvas: HTMLCanvasElement,
  options: BunnyPuppetOptions,
): BunnyPuppet | null {
  let gl: WebGLRenderingContext | null;
  try {
    gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
  } catch {
    options.onError?.();
    return null;
  }
  if (!gl) {
    options.onError?.();
    return null;
  }
  const context = gl;
  let state = { ...options };
  let disposed = false;
  let failed = false;
  let ready = false;
  let frame = 0;
  let lastFrame = 0;
  let imageRevision = 0;
  let pendingImage: HTMLImageElement | null = null;
  let activeMood = options.mood;
  let activeSrc = "";
  let requestedSrc = "";
  let texture: WebGLTexture | null = null;
  let imageAspect = 1;
  let canvasAspect = 1;
  let program: WebGLProgram | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let indexBuffer: WebGLBuffer | null = null;
  let observer: ResizeObserver | null = null;
  const start = performance.now();

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function fail() {
    if (disposed || failed) return;
    failed = true;
    stop();
    state.onError?.();
  }

  function shader(kind: number, source: string) {
    const result = context.createShader(kind);
    if (!result) throw new Error("Cannot create a mascot shader");
    context.shaderSource(result, source);
    context.compileShader(result);
    if (!context.getShaderParameter(result, context.COMPILE_STATUS)) {
      context.deleteShader(result);
      throw new Error("Cannot compile a mascot shader");
    }
    return result;
  }

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  function uniform(name: string) {
    return uniforms.get(name) ?? null;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || canvas.clientWidth || 300);
    const height = Math.max(1, rect.height || canvas.clientHeight || 300);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 1.7));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvasAspect = width / height;
    context.viewport(0, 0, canvas.width, canvas.height);
  }

  function landmarks(mood: BunnyMood) {
    if (mood === "sad")
      return { eyes: [0.44, 0.49, 0.61, 0.52], mouth: [0.52, 0.59] };
    if (mood === "rap")
      return { eyes: [0.45, 0.42, 0.61, 0.46], mouth: [0.51, 0.55] };
    if (mood === "rock")
      return { eyes: [0.43, 0.415, 0.61, 0.452], mouth: [0.51, 0.52] };
    return { eyes: [0.45, 0.42, 0.61, 0.46], mouth: [0.51, 0.5] };
  }

  function draw(now: number) {
    if (disposed || failed || !ready || !program || !texture) return;
    try {
      resize();
      const pose = getBunnyPose(
        Math.max(0, (now - start) / 1000),
        activeMood,
        state.playing,
        state.petting === true,
        state.reducedMotion === true,
      );
      const face = landmarks(activeMood);
      context.useProgram(program);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.uniform4f(
        uniform("u_root"),
        pose.rootX,
        pose.rootY,
        pose.rootRotate,
        pose.bodyBreath - 1,
      );
      context.uniform4f(
        uniform("u_head"),
        pose.headRotate,
        pose.headY,
        pose.earLeft,
        pose.earRight,
      );
      context.uniform4f(
        uniform("u_expression"),
        pose.pawLeft,
        pose.pawRight,
        pose.blink,
        pose.mouth,
      );
      context.uniform2f(uniform("u_eye_left"), face.eyes[0], face.eyes[1]);
      context.uniform2f(uniform("u_eye_right"), face.eyes[2], face.eyes[3]);
      context.uniform2f(uniform("u_mouth"), face.mouth[0], face.mouth[1]);
      context.uniform4f(
        uniform("u_paws"),
        activeMood === "rap" ? 0.37 : 0.44,
        activeMood === "rap" ? 0.66 : 0.8,
        activeMood === "rap" ? 0.69 : 0.62,
        activeMood === "rap" ? 0.67 : 0.8,
      );
      context.uniform1f(
        uniform("u_blink_allowed"),
        activeMood === "idle" || activeMood === "sad" ? 1 : 0,
      );
      context.uniform2f(
        uniform("u_contain"),
        // Leave room for the fluffy ear tips during the stronger head nods.
        Math.min(1, imageAspect / canvasAspect) * 0.94,
        Math.min(1, canvasAspect / imageAspect) * 0.94,
      );
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawElements(
        context.TRIANGLES,
        80 * 80 * 6,
        context.UNSIGNED_SHORT,
        0,
      );
    } catch {
      fail();
    }
  }

  function tick(now: number) {
    frame = 0;
    if (disposed || failed || document.hidden || state.reducedMotion) return;
    if (now - lastFrame >= 1000 / 30) {
      draw(now);
      lastFrame = now;
    }
    schedule();
  }

  function schedule() {
    if (
      disposed ||
      failed ||
      !ready ||
      frame ||
      document.hidden ||
      state.reducedMotion
    )
      return;
    frame = requestAnimationFrame(tick);
  }

  function cancelImage() {
    if (!pendingImage) return;
    pendingImage.onload = null;
    pendingImage.onerror = null;
    pendingImage.removeAttribute("src");
    pendingImage = null;
  }

  function loadImage(src: string, mood: BunnyMood) {
    cancelImage();
    requestedSrc = src;
    const revision = ++imageRevision;
    const image = new Image();
    image.decoding = "async";
    pendingImage = image;
    image.onload = () => {
      if (disposed || failed || revision !== imageRevision) return;
      pendingImage = null;
      try {
        const nextTexture = context.createTexture();
        if (!nextTexture) throw new Error("Cannot create mascot texture");
        context.bindTexture(context.TEXTURE_2D, nextTexture);
        context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
        context.texParameteri(
          context.TEXTURE_2D,
          context.TEXTURE_WRAP_S,
          context.CLAMP_TO_EDGE,
        );
        context.texParameteri(
          context.TEXTURE_2D,
          context.TEXTURE_WRAP_T,
          context.CLAMP_TO_EDGE,
        );
        context.texParameteri(
          context.TEXTURE_2D,
          context.TEXTURE_MIN_FILTER,
          context.LINEAR,
        );
        context.texParameteri(
          context.TEXTURE_2D,
          context.TEXTURE_MAG_FILTER,
          context.LINEAR,
        );
        context.texImage2D(
          context.TEXTURE_2D,
          0,
          context.RGBA,
          context.RGBA,
          context.UNSIGNED_BYTE,
          image,
        );
        if (texture) context.deleteTexture(texture);
        texture = nextTexture;
        imageAspect = image.naturalWidth / image.naturalHeight;
        activeSrc = src;
        activeMood = mood;
        ready = true;
        draw(performance.now());
        schedule();
        state.onReady?.();
      } catch {
        fail();
      }
    };
    image.onerror = () => {
      if (!disposed && revision === imageRevision) fail();
    };
    image.src = src;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else {
      draw(performance.now());
      schedule();
    }
  }

  function onResize() {
    draw(performance.now());
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    fail();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ++imageRevision;
    stop();
    cancelImage();
    observer?.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    if (texture) context.deleteTexture(texture);
    if (vertexBuffer) context.deleteBuffer(vertexBuffer);
    if (indexBuffer) context.deleteBuffer(indexBuffer);
    if (program) context.deleteProgram(program);
    texture = null;
    vertexBuffer = null;
    indexBuffer = null;
    program = null;
  }

  try {
    const vertex = shader(context.VERTEX_SHADER, VERTEX_SHADER);
    let fragment: WebGLShader;
    try {
      fragment = shader(context.FRAGMENT_SHADER, FRAGMENT_SHADER);
    } catch (error) {
      context.deleteShader(vertex);
      throw error;
    }
    program = context.createProgram();
    if (!program) {
      context.deleteShader(vertex);
      context.deleteShader(fragment);
      throw new Error("Cannot create a mascot program");
    }
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.linkProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (!context.getProgramParameter(program, context.LINK_STATUS))
      throw new Error("Cannot link a mascot program");
    context.useProgram(program);
    for (const name of [
      "u_root",
      "u_head",
      "u_expression",
      "u_eye_left",
      "u_eye_right",
      "u_mouth",
      "u_paws",
      "u_contain",
      "u_blink_allowed",
      "u_texture",
    ])
      uniforms.set(name, context.getUniformLocation(program, name));
    const geometry = mesh();
    vertexBuffer = context.createBuffer();
    indexBuffer = context.createBuffer();
    if (!vertexBuffer || !indexBuffer)
      throw new Error("Cannot create a mascot mesh");
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
    context.bufferData(context.ARRAY_BUFFER, geometry.uv, context.STATIC_DRAW);
    const position = context.getAttribLocation(program, "a_uv");
    if (position < 0) throw new Error("Missing mascot mesh attribute");
    context.enableVertexAttribArray(position);
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
    context.bufferData(
      context.ELEMENT_ARRAY_BUFFER,
      geometry.indices,
      context.STATIC_DRAW,
    );
    context.uniform1i(uniform("u_texture"), 0);
    context.clearColor(0, 0, 0, 0);
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
    canvas.addEventListener("webglcontextlost", onContextLost);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      observer.observe(canvas);
    }
    loadImage(state.src, state.mood);
  } catch {
    dispose();
    options.onError?.();
    return null;
  }

  return {
    update(next) {
      if (disposed || failed) return;
      state = { ...state, ...next };
      if (state.src !== requestedSrc) loadImage(state.src, state.mood);
      else if (activeSrc === state.src) activeMood = state.mood;
      if (state.reducedMotion) stop();
      draw(performance.now());
      schedule();
    },
    dispose,
  };
}
