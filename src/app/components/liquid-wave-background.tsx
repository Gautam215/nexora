"use client";

import { useEffect, useRef } from "react";

/* Liquid wave background, ported from Reelscape's profile page
   (LiquidWaveCanvas): a WebGL ripple field that follows the cursor.
   Decorative only — pointer-events are off and the canvas sits behind
   all page content. With reduced motion it draws a single still frame. */
export function LiquidWaveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { alpha: true, antialias: false });
    if (!canvas || !gl) return;

    const vertexSource = `
      attribute vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }
    `;
    const fragmentSource = `
      precision highp float;
      uniform vec2 resolution;
      uniform vec2 pointer;
      uniform float time;

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution;
        vec2 centered = uv - 0.5;
        centered.x *= resolution.x / resolution.y;
        vec2 cursor = pointer - 0.5;
        cursor.x *= resolution.x / resolution.y;
        vec2 delta = centered - cursor;
        float distanceToCursor = length(delta);
        float ripple = sin(distanceToCursor * 30.0 - time * 2.6) * exp(-distanceToCursor * 4.0);
        vec2 liquidUv = uv + normalize(delta + 0.0001) * ripple * 0.035;
        float waveOne = sin(liquidUv.x * 9.0 + liquidUv.y * 5.0 + time * 0.22);
        float waveTwo = sin(liquidUv.y * 15.0 - liquidUv.x * 4.0 - time * 0.16);
        float contour = smoothstep(-0.35, 0.82, waveOne * 0.65 + waveTwo * 0.35);
        float cursorGlow = exp(-distanceToCursor * 4.4);
        vec3 midnight = vec3(0.018, 0.024, 0.045);
        vec3 cobalt = vec3(0.14, 0.2, 0.48);
        vec3 silver = vec3(0.58, 0.68, 0.82);
        vec3 color = mix(midnight, cobalt, contour * 0.78);
        color = mix(color, silver, cursorGlow * 0.22 + contour * 0.08);
        color += vec3(0.08, 0.12, 0.22) * (1.0 - uv.y) * 0.5;
        gl_FragColor = vec4(color, 0.94);
      }
    `;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "position");
    const resolution = gl.getUniformLocation(program, "resolution");
    const pointer = gl.getUniformLocation(program, "pointer");
    const time = gl.getUniformLocation(program, "time");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const pointerPosition = { x: 0.5, y: 0.45 };
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const move = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointerPosition.x = (event.clientX - bounds.left) / bounds.width;
      pointerPosition.y = 1 - (event.clientY - bounds.top) / bounds.height;
    };

    resize();
    window.addEventListener("pointermove", move);
    window.addEventListener("resize", resize);
    let frame = 0;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const startedAt = performance.now();
    const render = (now: number) => {
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform2f(pointer, pointerPosition.x, pointerPosition.y);
      gl.uniform1f(time, (now - startedAt) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reducedMotion) frame = window.requestAnimationFrame(render);
    };
    frame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("resize", resize);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="liquid-wave-background"
      aria-hidden="true"
    />
  );
}
