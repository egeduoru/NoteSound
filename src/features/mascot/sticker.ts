export interface BunnyStickerOptions {
  src: string;
  playing: boolean;
  petting?: boolean;
  reducedMotion?: boolean;
  onReady?: () => void;
  onError?: () => void;
}

export interface BunnySticker {
  update(options: Partial<BunnyStickerOptions>): void;
  dispose(): void;
}

// The texture remains the exact supplied PNG. The crop only omits its empty
// outer columns; landmarks below still use coordinates of the original image.
const CROP = [205 / 1374, 0, 1005 / 1374, 1] as const;
const SEGMENTS = 80;

const VERTEX = `
precision highp float;
attribute vec2 a_uv;
uniform vec4 u_crop;
uniform vec4 u_root;
uniform vec4 u_upper;
uniform vec2 u_feet;
uniform vec2 u_contain;
varying vec2 v_uv;

vec2 rotate_at(vec2 point, vec2 pivot, float angle) {
  vec2 p = point - pivot;
  float s = sin(angle);
  float c = cos(angle);
  return pivot + vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float soft_area(vec2 point, vec2 center, vec2 radius) {
  vec2 distance = (point - center) / radius;
  return exp(-dot(distance, distance) * 2.0);
}

void main() {
  vec2 uv = u_crop.xy + a_uv * u_crop.zw;
  vec2 p = uv;

  // The cheek, resting hand and headphone cable travel together. Eyelids are
  // drawn separately in texture space, without squashing the face mesh.
  float torso = soft_area(uv, vec2(0.64, 0.72), vec2(0.31, 0.23));
  p.y += (uv.y - 0.89) * u_root.w * torso;
  p.x += (uv.x - 0.62) * u_root.w * torso * 0.35;

  float drooping_ear = (1.0 - smoothstep(0.43, 0.52, uv.y))
                     * (1.0 - smoothstep(0.49, 0.59, uv.x));
  float upright_ear = (1.0 - smoothstep(0.25, 0.35, uv.y))
                    * smoothstep(0.53, 0.62, uv.x);
  p += (rotate_at(p, vec2(0.55, 0.36), u_upper.z) - p) * drooping_ear;
  p += (rotate_at(p, vec2(0.74, 0.34), u_upper.w) - p) * upright_ear;

  float head = (1.0 - smoothstep(0.57, 0.74, uv.y))
             * smoothstep(0.35, 0.46, uv.x);
  float cheek_hand = soft_area(uv, vec2(0.755, 0.635), vec2(0.10, 0.14));
  float upper = max(head, cheek_hand * 0.8);
  p += (rotate_at(p, vec2(0.66, 0.67), u_upper.x) - p) * upper;
  p.y += u_upper.y * upper;

  // Each shoe taps from its own ankle. The soft masks keep the socks joined
  // to the legs while giving the reclining pose a distinct listening rhythm.
  float left_shoe = soft_area(uv, vec2(0.295, 0.87), vec2(0.17, 0.13));
  float right_shoe = soft_area(uv, vec2(0.55, 0.925), vec2(0.13, 0.11));
  p += (rotate_at(p, vec2(0.41, 0.81), u_feet.x) - p) * left_shoe;
  p += (rotate_at(p, vec2(0.63, 0.83), u_feet.y) - p) * right_shoe;

  p = rotate_at(p, vec2(0.57, 0.91), u_root.z);
  p += u_root.xy;
  vec2 local = (p - u_crop.xy) / u_crop.zw;
  vec2 centered = (local - 0.5) * u_contain;
  gl_Position = vec4(centered.x * 2.0, -centered.y * 2.0, 0.0, 1.0);
  v_uv = uv;
}
`;

// Eye contours measured on the supplied illustration, including the eyeliner.
// Working in source pixels keeps the eyelids aligned with the moving mesh.
const eyeBounds = (
  name: string,
  points: ReadonlyArray<readonly [number, number, number]>,
) => `vec2 ${name}(float x) {
${points
  .slice(1)
  .map((point, index) => {
    const previous = points[index];
    return `if (x <= ${point[0]}.0) return mix(vec2(${previous[1]}.0, ${previous[2]}.0), vec2(${point[1]}.0, ${point[2]}.0), clamp((x - ${previous[0]}.0) / ${point[0] - previous[0]}.0, 0.0, 1.0));`;
  })
  .join("\n")}
return vec2(${points.at(-1)![1]}.0, ${points.at(-1)![2]}.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_blink;
varying vec2 v_uv;
${eyeBounds("right_bounds", [
  [945, 555, 557],
  [951, 545, 561],
  [971, 526, 563],
  [991, 514, 557],
  [1011, 506, 552],
  [1031, 500, 547],
  [1051, 496, 544],
  [1063, 490, 532],
  [1069, 484, 510],
])}
vec4 wink_eye(vec2 pixel, vec4 original) {
  float first = 945.0;
  float last = 1069.0;
  if (pixel.x < first - 1.0 || pixel.x > last + 1.0) return original;
  vec2 edges = right_bounds(pixel.x);
  float mask = smoothstep(first - 1.0, first + 1.0, pixel.x)
             * (1.0 - smoothstep(last - 1.0, last + 1.0, pixel.x))
             * smoothstep(edges.x - 6.0, edges.x - 3.0, pixel.y)
             * (1.0 - smoothstep(edges.y + 3.0, edges.y + 6.0, pixel.y));
  if (mask < 0.001) return original;

  // Only the eye on the viewer's right winks. Its slanted lash is preserved;
  // the large open eye on the viewer's left remains the original texture.
  float shut = edges.x + 2.0;
  float top = mix(edges.x, shut, u_blink);
  float bottom = mix(edges.y, shut + 0.7, u_blink);
  float aperture = smoothstep(top - 0.6, top + 0.6, pixel.y)
                 * (1.0 - smoothstep(bottom - 0.6, bottom + 0.6, pixel.y));
  float sampleY = mix(edges.x, edges.y,
    clamp((pixel.y - top) / max(bottom - top, 0.7), 0.0, 1.0));
  vec4 eye = texture2D(u_texture, vec2(v_uv.x, sampleY / 1145.0));
  vec4 skin = texture2D(u_texture, vec2(997.0 / 1374.0, 490.0 / 1145.0));
  vec4 fill = vec4(skin.rgb / max(skin.a, 0.001) * original.a, original.a);
  vec4 result = mix(fill, eye, aperture * (1.0 - smoothstep(0.93, 1.0, u_blink)));
  float lash = (1.0 - smoothstep(2.4, 3.7, abs(pixel.y - top)))
             * smoothstep(0.08, 0.55, u_blink);
  result.rgb = mix(result.rgb, vec3(0.145, 0.008, 0.018) * original.a, lash);
  return mix(original, result, mask);
}

void main() {
  vec4 color = texture2D(u_texture, v_uv);
  if (u_blink > 0.001) {
    vec2 pixel = v_uv * vec2(1374.0, 1145.0);
    if (pixel.y > 478.0 && pixel.y < 632.0) {
      color = wink_eye(pixel, color);
    }
  }
  gl_FragColor = color;
}
`;

function geometry() {
  const uv = new Float32Array((SEGMENTS + 1) ** 2 * 2);
  const indices = new Uint16Array(SEGMENTS ** 2 * 6);
  let vertex = 0;
  let triangle = 0;
  for (let y = 0; y <= SEGMENTS; y++) {
    for (let x = 0; x <= SEGMENTS; x++) {
      uv[vertex++] = x / SEGMENTS;
      uv[vertex++] = y / SEGMENTS;
    }
  }
  for (let y = 0; y < SEGMENTS; y++) {
    for (let x = 0; x < SEGMENTS; x++) {
      const a = y * (SEGMENTS + 1) + x;
      const b = a + 1;
      const c = a + SEGMENTS + 1;
      const d = c + 1;
      for (const point of [a, b, c, b, d, c]) indices[triangle++] = point;
    }
  }
  return { uv, indices };
}

const wave = (time: number, period: number, phase = 0) =>
  Math.sin((time / period) * Math.PI * 2 + phase);

function pulse(time: number, period: number, center: number, width: number) {
  const distance = Math.abs((time % period) - center);
  return distance < width
    ? (Math.cos((distance / width) * Math.PI) + 1) / 2
    : 0;
}

// Quick closure, a short hold and a softer reopening. The long cycle includes
// one double wink, so the gaze does not look like a repeating metronome.
function blinkAmount(time: number) {
  const phase = time % 18.4;
  for (const start of [1.9, 6.25, 10.7, 15.1, 15.48]) {
    const t = phase - start;
    if (t < 0 || t > 0.26) continue;
    if (t < 0.085) return (1 - Math.cos((Math.PI * t) / 0.085)) / 2;
    if (t < 0.13) return 1;
    return (1 + Math.cos((Math.PI * (t - 0.13)) / 0.13)) / 2;
  }
  return 0;
}

/** A lively mesh animation of one supplied sticker, independent of audio
 * decoding. Only the eye on the viewer's right winks; the left stays open. */
export function createBunnySticker(
  canvas: HTMLCanvasElement,
  options: BunnyStickerOptions,
): BunnySticker | null {
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
  let requestedSrc = "";
  let imageAspect = 1005 / 1145;
  let pendingImage: HTMLImageElement | null = null;
  let texture: WebGLTexture | null = null;
  let program: WebGLProgram | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let indexBuffer: WebGLBuffer | null = null;
  let observer: ResizeObserver | null = null;
  const start = performance.now();
  let lastPoseTime = start;
  let listeningLevel = options.playing ? 1 : 0;
  let petLevel = 0;
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const uniform = (name: string) => uniforms.get(name) ?? null;

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

  function draw(now: number) {
    if (disposed || failed || !ready || !program || !texture) return;
    try {
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
      context.viewport(0, 0, canvas.width, canvas.height);
      const time = Math.max(0, (now - start) / 1000);
      const moving = state.reducedMotion ? 0 : 1;
      const dt = Math.min(0.1, Math.max(0, (now - lastPoseTime) / 1000));
      lastPoseTime = now;
      listeningLevel +=
        ((state.playing ? 1 : 0) - listeningLevel) * (1 - Math.exp(-dt / 0.2));
      petLevel +=
        ((state.petting ? 1 : 0) - petLevel) * (1 - Math.exp(-dt / 0.09));
      const listening = listeningLevel;
      const petting = petLevel;
      const breath = 0.017 * wave(time, 3.6);
      const nod = listening * wave(time, 1.35);
      context.useProgram(program);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.uniform1f(uniform("u_blink"), moving * blinkAmount(time));
      context.uniform4f(
        uniform("u_root"),
        moving * 0.0035 * wave(time, 5.8),
        moving *
          (0.008 * wave(time, 3.6) +
            0.006 * nod +
            petting * 0.011 * wave(time, 0.44)),
        moving * (0.018 * wave(time, 5.8) + listening * 0.01 * wave(time, 2.7)),
        moving * breath,
      );
      context.uniform4f(
        uniform("u_upper"),
        moving * (0.025 * wave(time, 5.8) + 0.025 * nod),
        moving * (0.0035 * wave(time, 3.6, 0.6) + 0.004 * nod),
        moving *
          (0.035 * wave(time, 3.7) +
            0.075 * pulse(time, 4.9, 1.35, 0.6) +
            listening * 0.015 * wave(time, 1.35, 0.8) +
            petting * 0.055 * wave(time, 0.52)),
        moving *
          (0.035 * wave(time, 4.2, 1) -
            0.075 * pulse(time, 5.6, 3.1, 0.5) -
            listening * 0.013 * wave(time, 1.35, 1.2) -
            petting * 0.05 * wave(time, 0.52)),
      );
      context.uniform2f(
        uniform("u_feet"),
        moving *
          (0.035 * wave(time, 3.2) +
            listening * 0.035 * wave(time, 0.675) +
            petting * 0.03 * wave(time, 0.44)),
        moving *
          (0.018 * wave(time, 3.8, 1.2) +
            listening * 0.025 * wave(time, 1.35, 0.7)),
      );
      context.uniform2f(
        uniform("u_contain"),
        Math.min(1, imageAspect / (width / height)) * 0.88,
        Math.min(1, width / height / imageAspect) * 0.88,
      );
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawElements(
        context.TRIANGLES,
        SEGMENTS ** 2 * 6,
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

  function loadImage(src: string) {
    cancelImage();
    requestedSrc = src;
    const revision = ++imageRevision;
    const image = new Image();
    image.decoding = "async";
    pendingImage = image;
    image.onload = () => {
      if (disposed || failed || revision !== imageRevision) return;
      pendingImage = null;
      let nextTexture: WebGLTexture | null = null;
      try {
        nextTexture = context.createTexture();
        if (!nextTexture) throw new Error("Cannot create sticker texture");
        context.activeTexture(context.TEXTURE0);
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
        if (context.getError() !== context.NO_ERROR)
          throw new Error("Cannot upload sticker texture");
        if (texture) context.deleteTexture(texture);
        texture = nextTexture;
        imageAspect =
          (image.naturalWidth * CROP[2]) / (image.naturalHeight * CROP[3]);
        ready = true;
        draw(performance.now());
        schedule();
        if (!failed) state.onReady?.();
      } catch {
        if (nextTexture && texture !== nextTexture)
          context.deleteTexture(nextTexture);
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
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    if (texture) context.deleteTexture(texture);
    if (vertexBuffer) context.deleteBuffer(vertexBuffer);
    if (indexBuffer) context.deleteBuffer(indexBuffer);
    if (program) context.deleteProgram(program);
  }

  function shader(type: number, source: string) {
    const result = context.createShader(type);
    if (!result) throw new Error("Cannot create sticker shader");
    context.shaderSource(result, source);
    context.compileShader(result);
    if (!context.getShaderParameter(result, context.COMPILE_STATUS)) {
      context.deleteShader(result);
      throw new Error("Cannot compile sticker shader");
    }
    return result;
  }

  try {
    const vertex = shader(context.VERTEX_SHADER, VERTEX);
    let fragment: WebGLShader;
    try {
      fragment = shader(context.FRAGMENT_SHADER, FRAGMENT);
    } catch (error) {
      context.deleteShader(vertex);
      throw error;
    }
    program = context.createProgram();
    if (!program) {
      context.deleteShader(vertex);
      context.deleteShader(fragment);
      throw new Error("Cannot create sticker program");
    }
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.linkProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (!context.getProgramParameter(program, context.LINK_STATUS))
      throw new Error("Cannot link sticker program");
    context.useProgram(program);
    for (const name of [
      "u_crop",
      "u_root",
      "u_upper",
      "u_feet",
      "u_contain",
      "u_texture",
      "u_blink",
    ])
      uniforms.set(name, context.getUniformLocation(program, name));
    context.uniform4f(uniform("u_crop"), ...CROP);
    const mesh = geometry();
    vertexBuffer = context.createBuffer();
    indexBuffer = context.createBuffer();
    if (!vertexBuffer || !indexBuffer)
      throw new Error("Cannot create sticker mesh");
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
    context.bufferData(context.ARRAY_BUFFER, mesh.uv, context.STATIC_DRAW);
    const position = context.getAttribLocation(program, "a_uv");
    if (position < 0) throw new Error("Missing sticker mesh attribute");
    context.enableVertexAttribArray(position);
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
    context.bufferData(
      context.ELEMENT_ARRAY_BUFFER,
      mesh.indices,
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
    loadImage(state.src);
  } catch {
    dispose();
    options.onError?.();
    return null;
  }

  return {
    update(next) {
      if (disposed || failed) return;
      state = { ...state, ...next };
      if (state.src !== requestedSrc) loadImage(state.src);
      if (state.reducedMotion) stop();
      draw(performance.now());
      schedule();
    },
    dispose,
  };
}
