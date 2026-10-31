export interface BunnyVideoOptions {
  reducedMotion?: boolean;
  onReady?: () => void;
  onError?: () => void;
}

export interface BunnyVideoRenderer {
  update(options: Pick<BunnyVideoOptions, "reducedMotion">): void;
  dispose(): void;
}

const VERTEX = `
attribute vec2 a_position;
uniform vec2 u_contain;
uniform vec4 u_crop;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position * u_contain, 0.0, 1.0);
  vec2 uv = vec2((a_position.x + 1.0) * 0.5,
                 (1.0 - a_position.y) * 0.5);
  v_uv = u_crop.xy + uv * u_crop.zw;
}
`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D u_video;
varying vec2 v_uv;
void main() {
  vec3 color = texture2D(u_video, v_uv).rgb;
  // A dominance key tolerates MP4 compression and variations in the green
  // backdrop while preserving the pink character and its black hoodie.
  float other = max(color.r, color.b);
  float excess = max(0.0, color.g - other);
  float key = smoothstep(0.035, 0.25, excess)
            * smoothstep(0.16, 0.45, color.g);
  float alpha = 1.0 - key;
  // Remove the green cast from antialiased outlines before premultiplication.
  color.g = min(color.g, other + 0.025);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** Draws the supplied film itself, with a transparent chroma-keyed surround.
 * The caller owns autoplay, muting and the video's visibility lifecycle. */
export function createBunnyVideoRenderer(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options: BunnyVideoOptions = {},
): BunnyVideoRenderer | null {
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
  let uploadedTime = -1;
  let program: WebGLProgram | null = null;
  let geometry: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let contain: WebGLUniformLocation | null = null;
  let crop: WebGLUniformLocation | null = null;

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

  function shader(type: number, source: string) {
    const result = context.createShader(type);
    if (!result) throw new Error("Cannot create mascot video shader");
    context.shaderSource(result, source);
    context.compileShader(result);
    if (!context.getShaderParameter(result, context.COMPILE_STATUS)) {
      context.deleteShader(result);
      throw new Error("Cannot compile mascot video shader");
    }
    return result;
  }

  function draw(force = false) {
    if (disposed || failed || video.readyState < 2 || !video.videoWidth) return;
    try {
      const bounds = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, bounds.width);
      const cssHeight = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));
      const resized = canvas.width !== width || canvas.height !== height;
      if (resized) {
        canvas.width = width;
        canvas.height = height;
      }
      if (!force && !resized && uploadedTime === video.currentTime) return;
      context.viewport(0, 0, width, height);
      context.useProgram(program);
      context.bindTexture(context.TEXTURE_2D, texture);
      if (force || uploadedTime !== video.currentTime) {
        context.texImage2D(
          context.TEXTURE_2D, 0, context.RGBA, context.RGBA,
          context.UNSIGNED_BYTE, video,
        );
        uploadedTime = video.currentTime;
      }
      const square = Math.min(video.videoWidth, video.videoHeight);
      const x = square / video.videoWidth;
      const y = square / video.videoHeight;
      context.uniform4f(crop, (1 - x) * 0.5, (1 - y) * 0.5, x, y);
      context.uniform2f(
        contain,
        Math.min(1, height / width) * 0.94,
        Math.min(1, width / height) * 0.94,
      );
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
      if (!ready) {
        if (context.getError() !== context.NO_ERROR) throw new Error("Mascot video draw failed");
        ready = true;
        state.onReady?.();
      }
    } catch {
      fail();
    }
  }

  function schedule() {
    if (disposed || failed || frame || state.reducedMotion || document.hidden || video.paused || video.ended) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    frame = 0;
    if (disposed || failed || state.reducedMotion || document.hidden || video.paused) return;
    if (now - lastFrame >= 1000 / 30) {
      draw();
      lastFrame = now;
    }
    schedule();
  }

  function onFrameAvailable() {
    draw(true);
    schedule();
  }

  function onPause() {
    stop();
    draw(true);
  }

  function onResize() {
    draw(true);
  }

  function onVisibility() {
    if (document.hidden) stop();
    else onFrameAvailable();
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    fail();
  }

  const availableEvents = ["loadeddata", "seeked", "playing", "play"];
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    resizeObserver?.disconnect();
    for (const event of availableEvents) video.removeEventListener(event, onFrameAvailable);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("error", fail);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    if (texture) context.deleteTexture(texture);
    if (geometry) context.deleteBuffer(geometry);
    if (program) context.deleteProgram(program);
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
      throw new Error("Cannot create mascot video program");
    }
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.linkProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error("Cannot link mascot video program");
    context.useProgram(program);
    geometry = context.createBuffer();
    texture = context.createTexture();
    if (!geometry || !texture) throw new Error("Cannot allocate mascot video resources");
    context.bindBuffer(context.ARRAY_BUFFER, geometry);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW);
    const position = context.getAttribLocation(program, "a_position");
    if (position < 0) throw new Error("Missing mascot video position");
    context.enableVertexAttribArray(position);
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    contain = context.getUniformLocation(program, "u_contain");
    crop = context.getUniformLocation(program, "u_crop");
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.uniform1i(context.getUniformLocation(program, "u_video"), 0);
    context.clearColor(0, 0, 0, 0);
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
    for (const event of availableEvents) video.addEventListener(event, onFrameAvailable);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", fail);
    canvas.addEventListener("webglcontextlost", onContextLost);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(canvas);
    }
    onFrameAvailable();
  } catch {
    dispose();
    options.onError?.();
    return null;
  }

  return {
    update(next) {
      if (disposed || failed) return;
      state = { ...state, ...next };
      if (state.reducedMotion) stop();
      draw(true);
      schedule();
    },
    dispose,
  };
}
