"use client";

import { useEffect, useRef } from "react";

export function WireframeBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const W = window.innerWidth;
      const H = window.innerHeight;
      canvas!.width = W * dpr;
      canvas!.height = H * dpr;
      canvas!.style.width = W + "px";
      canvas!.style.height = H + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const gridCols = 70;
      const gridRows = 45;
      const gridW = W * 2.8;
      const gridH = H * 3.2;
      const camY = -280;
      const camZ = 200;
      const fov = 550;

      function noise(x: number, y: number): number {
        return (
          Math.sin(x * 1.1 + y * 0.7) * 0.5 +
          Math.sin(x * 0.7 - y * 1.3 + 2.1) * 0.3 +
          Math.sin(x * 2.1 + y * 0.4 + 5.3) * 0.15 +
          Math.cos(x * 0.3 + y * 2.2 + 1.7) * 0.25 +
          Math.sin(x * 3.3 - y * 1.8 + 4.2) * 0.1
        );
      }

      function wave3d(gx: number, gy: number): number {
        const big =
          Math.sin(gx * 0.04 + gy * 0.02 + 0.5) * 120 +
          Math.cos(gx * 0.02 - gy * 0.035 + 2.0) * 90;
        const med =
          Math.sin(gx * 0.09 + gy * 0.06 + 1.2) * 40 +
          Math.cos(gx * 0.07 - gy * 0.09 + 3.5) * 30 +
          Math.sin(gx * 0.13 + gy * 0.035 + 5.0) * 20;
        const small = noise(gx * 0.25, gy * 0.2) * 35;
        const warp =
          Math.sin(gx * 0.03 + Math.sin(gy * 0.04) * 3.5) * 55 +
          Math.cos(gy * 0.035 + Math.cos(gx * 0.05) * 3) * 35;
        return big + med + small + warp;
      }

      function jitter(seed: number): number {
        return ((Math.sin(seed * 127.1 + 311.7) * 43758.5453) % 1) * 0.4 - 0.2;
      }

      // Build grid
      const pts: Array<Array<{ x: number; y: number; z: number }>> = [];
      for (let r = 0; r < gridRows; r++) {
        const row: Array<{ x: number; y: number; z: number }> = [];
        for (let c = 0; c < gridCols; c++) {
          const jx = jitter(r * gridCols + c) * 10;
          const jy = jitter(r * gridCols + c + 9999) * 8;
          const gx = (c / gridCols - 0.5) * gridW + jx;
          const gy = (r / gridRows) * gridH + jy;
          const gz = wave3d(gx * 0.018, gy * 0.015);
          row.push({ x: gx, y: gz, z: gy });
        }
        pts.push(row);
      }

      function project(p: { x: number; y: number; z: number }) {
        const dy = p.y - camY;
        const dz = p.z - camZ;
        const z = Math.max(dz, 1);
        const scale = fov / z;
        return { sx: W / 2 + p.x * scale, sy: H * 0.3 + dy * scale, depth: z };
      }

      ctx!.clearRect(0, 0, W, H);

      // Opacity multiplier — controls overall brightness
      const brightness = 0.7;

      for (let r = gridRows - 1; r >= 0; r--) {
        for (let c = 0; c < gridCols; c++) {
          const p = pts[r][c];
          const s = project(p);
          if (s.sx < -100 || s.sx > W + 100 || s.sy < -100 || s.sy > H + 100) continue;

          const depthFade = Math.max(0, Math.min(1, 1 - (s.depth - camZ) / (gridH * 0.85)));
          const heightNorm = Math.max(0, Math.min(1, (p.y - camY + 150) / 300));

          const rr = Math.floor(3 + heightNorm * 10);
          const gg = Math.floor(80 + heightNorm * 105);
          const bb = Math.floor(55 + heightNorm * 40);

          // Horizontal lines
          if (c < gridCols - 1) {
            const p2 = pts[r][c + 1];
            const s2 = project(p2);
            const h2 = Math.max(0, Math.min(1, (p2.y - camY + 150) / 300));
            const avgH = (heightNorm + h2) / 2;
            const a = depthFade * (0.07 + avgH * 0.28) * brightness;
            if (a > 0.005 && s2.sx > -100 && s2.sx < W + 100) {
              ctx!.beginPath();
              ctx!.moveTo(s.sx, s.sy);
              ctx!.lineTo(s2.sx, s2.sy);
              ctx!.strokeStyle = `rgba(${rr},${gg},${bb},${a})`;
              ctx!.lineWidth = 0.3 + depthFade * avgH * 1.0;
              ctx!.stroke();
            }
          }

          // Vertical lines
          if (r < gridRows - 1) {
            const p2 = pts[r + 1][c];
            const s2 = project(p2);
            const h2 = Math.max(0, Math.min(1, (p2.y - camY + 150) / 300));
            const avgH = (heightNorm + h2) / 2;
            const a = depthFade * (0.05 + avgH * 0.22) * brightness;
            if (a > 0.005 && s2.sy > -100 && s2.sy < H + 100) {
              ctx!.beginPath();
              ctx!.moveTo(s.sx, s.sy);
              ctx!.lineTo(s2.sx, s2.sy);
              ctx!.strokeStyle = `rgba(${rr},${gg},${bb},${a})`;
              ctx!.lineWidth = 0.2 + depthFade * avgH * 0.7;
              ctx!.stroke();
            }
          }

          // Glow dots on peaks
          if (heightNorm > 0.45 && depthFade > 0.15) {
            const dotA = depthFade * heightNorm * 0.35 * brightness;
            const dotR = 0.3 + depthFade * heightNorm * 1.5;
            ctx!.beginPath();
            ctx!.arc(s.sx, s.sy, dotR, 0, Math.PI * 2);
            ctx!.fillStyle = `rgba(16,${gg},${bb},${dotA})`;
            ctx!.fill();
            if (heightNorm > 0.75 && depthFade > 0.4) {
              ctx!.beginPath();
              ctx!.arc(s.sx, s.sy, dotR * 3, 0, Math.PI * 2);
              ctx!.fillStyle = `rgba(16,${gg},${bb},${dotA * 0.1})`;
              ctx!.fill();
            }
          }
        }
      }
    }

    draw();

    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0"
        style={{ zIndex: -1 }}
        aria-hidden="true"
      />
      {/* Edge fade */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          zIndex: -1,
          background:
            "linear-gradient(to bottom, #0a0a0a 0%, transparent 12%, transparent 85%, #0a0a0a 100%), linear-gradient(to right, #0a0a0a 0%, transparent 8%, transparent 92%, #0a0a0a 100%)",
        }}
        aria-hidden="true"
      />
    </>
  );
}
