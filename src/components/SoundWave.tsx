import { useEffect, useRef } from 'react';
import type { AppState } from '../types';

interface SoundWaveProps {
  state: AppState;
  /** Livello 0..1: microfono mentre ascolta, voce di Jev mentre parla (backend Rust). */
  getLevel?: () => number;
  /** Jev sta parlando: colori caldi invece di quelli freddi dell'ascolto. */
  speaking?: boolean;
}

const BARS = 7;
const GAP = 3;

/**
 * Onda compatta stile Dynamic Island (Canvas 2D): 7 barre arrotondate.
 * listening = segue la voce, processing = onda che scorre, done = respiro calmo.
 */
export default function SoundWave({ state, getLevel, speaking = false }: SoundWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Niente loop a 60 fps quando il notch è nascosto (idle/setup/closing).
    if (state !== 'listening' && state !== 'processing' && state !== 'done') return;

    const barW = (w - GAP * (BARS - 1)) / BARS;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, speaking ? '#ffd36e' : '#5ee7ff');
    grad.addColorStop(1, speaking ? '#ff7eb6' : '#b18cff');
    let raf = 0;
    let t = 0;
    let smooth = 0; // il livello arriva a scatti ogni 40 ms: lo si segue morbido

    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = grad;
      smooth += ((getLevel?.() ?? 0) - smooth) * 0.25;
      const level = smooth;
      for (let i = 0; i < BARS; i++) {
        const wave = Math.abs(Math.sin(i * 0.9 + t * 7) * Math.cos(i * 0.4 - t * 3));
        const amp =
          state === 'listening'
            ? level * (0.4 + 0.6 * wave)
            : state === 'processing'
              ? 0.3 + 0.25 * Math.sin(t * 6 - i * 0.8)
              : 0.18 + 0.06 * Math.sin(t * 2 + i);
        const bh = Math.max(barW, Math.min(amp, 1) * h);
        roundedRect(ctx, i * (barW + GAP), (h - bh) / 2, barW, bh, barW / 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state, getLevel, speaking]);

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
