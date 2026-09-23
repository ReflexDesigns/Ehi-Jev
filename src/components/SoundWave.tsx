import { useEffect, useRef } from 'react';
import type { AudioFrame } from '../lib/micRecorder';
import type { AppState } from '../types';

interface SoundWaveProps {
  state: AppState;
  getFrame?: () => AudioFrame;
}

/**
 * Visualizzatore audio futuristico (Canvas 2D).
 *
 * - listening:  barre a specchio reattive allo spettro della voce,
 *               gradiente viola/ciano/blu elettrico.
 * - processing: bagliore pulsante + orbite rotanti (gradiente fluido).
 * - done:       onda calma di conferma.
 */
export default function SoundWave({ state, getFrame }: SoundWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let t = 0;

    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, w, h);

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#00f2fe');
      grad.addColorStop(0.4, '#38ef7d');
      grad.addColorStop(0.7, '#7f00ff');
      grad.addColorStop(1, '#e100ff');

      if (state === 'listening' && getFrame) {
        // --- Onda reattiva alla voce ---
        const { level, freq } = getFrame();
        const bars = 56;
        const gap = 2;
        const barW = (w - gap * (bars - 1)) / bars;
        ctx.fillStyle = grad;
        for (let i = 0; i < bars; i++) {
          const idx = Math.floor((i / bars) * freq.length);
          const v = (freq[idx] ?? 0) / 255;
          const amp = Math.max(0.08, v) * (0.4 + level * 2.4);
          const bh = Math.min(amp * h * 0.85, h * 0.9);
          const x = i * (barW + gap);
          const y = (h - bh) / 2;
          roundedRect(ctx, x, y, barW, bh, barW / 2);
          ctx.fill();
        }
      } else if (state === 'processing') {
        // --- Bagliore rotante / pulsing gradient ---
        const cx = w / 2;
        const cy = h / 2;
        const pulse = 0.6 + 0.4 * Math.sin(t * 6);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3;
        ctx.shadowColor = '#7f00ff';
        ctx.shadowBlur = 18 * pulse;
        ctx.beginPath();
        ctx.arc(cx, cy, 18 + 6 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;

        const colors = ['#00f2fe', '#7f00ff', '#e100ff'];
        for (let i = 0; i < 3; i++) {
          const angle = t * 2 + (i * Math.PI * 2) / 3;
          const r = 30;
          ctx.fillStyle = colors[i];
          ctx.beginPath();
          ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (state === 'done') {
        // --- Onda calma di conferma ---
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#7f00ff';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        const mid = h / 2;
        for (let x = 0; x <= w; x += 2) {
          const y =
            mid +
            Math.sin(x * 0.03 + t * 2) * 4 +
            Math.sin(x * 0.011 - t) * 3;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state, getFrame]);

  return <canvas ref={canvasRef} className="soundwave" />;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
