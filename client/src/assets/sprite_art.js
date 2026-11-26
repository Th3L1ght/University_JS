/**
 * Векторна графіка спрайт-листів: чисті функції, що повертають текст SVG.
 * Їх використовує scripts/generate_assets.mjs (записує public/assets/*.svg) і резервний режим
 * для file:// (той самий SVG підставляється як data-URI, без жодного запиту до мережі).
 */

import { SPRITE_SHEETS, ASTEROID_VARIANTS, asteroidFrameName } from './atlas.js';
import { createRng } from '../sim/rng.js';

const TAU = Math.PI * 2;

function svgDocument(width, height, defs, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">\n<defs>\n${defs}\n</defs>\n${body}\n</svg>\n`
  );
}

const placeAt = (frame, inner) =>
  `<g transform="translate(${frame.x} ${frame.y})">\n${inner}\n</g>`;

function buildSpritesSvg(sheet) {
  const f = sheet.frames;
  const defs = `
<linearGradient id="hull" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#1f4468"/><stop offset="1" stop-color="#0b1626"/>
</linearGradient>
<radialGradient id="glow">
  <stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#bff3ff"/>
  <stop offset="1" stop-color="#5fd7ff" stop-opacity="0"/>
</radialGradient>`;

  const ship = `
<path d="M84 48 L24 26 L36 48 L24 70 Z" fill="url(#hull)" stroke="#5fd7ff" stroke-width="3" stroke-linejoin="round"/>
<path d="M40 36 L62 44 M40 60 L62 52" stroke="#5fd7ff" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round"/>
<ellipse cx="58" cy="48" rx="9" ry="4.5" fill="#5fd7ff" fill-opacity="0.85"/>`;

  const flame = (tipX) => `
<path d="M62 22 L${tipX} 32 L62 42 Z" fill="#ff9a2e"/>
<path d="M62 27 L${tipX + 22} 32 L62 37 Z" fill="#ffe38a"/>`;

  const bullet = `
<line x1="2" y1="16" x2="16" y2="16" stroke="#78e6ff" stroke-opacity="0.55" stroke-width="4" stroke-linecap="round"/>
<circle cx="16" cy="16" r="9" fill="url(#glow)"/>
<circle cx="16" cy="16" r="4.5" fill="#f2fdff"/>`;

  const missile = `
<path d="M12 11 L2 16 L12 21 Z" fill="#ff7a2e"/>
<path d="M40 16 L12 7 L12 25 Z" fill="#ffd9a8" stroke="#ff9a2e" stroke-width="3" stroke-linejoin="round"/>`;

  const pickup = (color, icon) => `
<circle cx="32" cy="32" r="28" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="4"/>
${icon}`;

  const healIcon = (color) =>
    `<path d="M20 32 H44 M32 20 V44" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`;
  const rapidIcon = (color) =>
    `<path d="M17 22 L29 32 L17 42 M32 22 L44 32 L32 42" stroke="${color}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

  const body = [
    placeAt(f.ship, ship),
    placeAt(f.flame_a, flame(2)),
    placeAt(f.flame_b, flame(16)),
    placeAt(f.bullet, bullet),
    placeAt(f.missile, missile),
    placeAt(f.pickup_heal, pickup('#5dff9a', healIcon('#5dff9a'))),
    placeAt(f.pickup_rapid, pickup('#ffd84a', rapidIcon('#ffd84a'))),
  ].join('\n');

  return svgDocument(sheet.width, sheet.height, defs, body);
}

/** Один астероїд: нерівний контур, кратери, для «мисливця» - червоне ядро й тріщини. */
function asteroidFrameSvg(frame, seed, hunter) {
  const rng = createRng(seed);
  const cx = frame.w / 2;
  const cy = frame.h / 2;
  const baseRadius = frame.w * 0.4;

  const points = [];
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU;
    const r = baseRadius * (0.82 + rng() * 0.36);
    points.push(
      `${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r).toFixed(1)}`,
    );
  }

  const stroke = hunter ? '#ff6b5a' : '#9aa7b8';
  const fill = hunter ? 'url(#rockHunter)' : 'url(#rock)';
  let inner = `<polygon points="${points.join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="3" stroke-linejoin="round"/>`;

  for (let i = 0; i < 3; i += 1) {
    const x = cx + (rng() - 0.5) * baseRadius * 1.0;
    const y = cy + (rng() - 0.5) * baseRadius * 1.0;
    const r = baseRadius * (0.1 + rng() * 0.14);
    inner += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#000000" fill-opacity="0.22" stroke="${stroke}" stroke-opacity="0.35" stroke-width="1.5"/>`;
  }

  if (hunter) {
    const spokes = [0.4, 1.9, 3.4, 5.0];
    const path = spokes
      .map(
        (a) =>
          `M${cx} ${cy} L${(cx + Math.cos(a) * baseRadius * 0.8).toFixed(1)} ${(cy + Math.sin(a) * baseRadius * 0.8).toFixed(1)}`,
      )
      .join(' ');
    inner += `<path d="${path}" stroke="#ff6b5a" stroke-opacity="0.7" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    inner += `<circle cx="${cx}" cy="${cy}" r="${(baseRadius * 0.2).toFixed(1)}" fill="url(#core)"/>`;
  }
  return placeAt(frame, inner);
}

function buildAsteroidsSvg(sheet) {
  const defs = `
<radialGradient id="rock" cx="0.35" cy="0.3" r="0.9">
  <stop offset="0" stop-color="#3a475c"/><stop offset="1" stop-color="#111827"/>
</radialGradient>
<radialGradient id="rockHunter" cx="0.35" cy="0.3" r="0.9">
  <stop offset="0" stop-color="#4a2127"/><stop offset="1" stop-color="#1a0b0f"/>
</radialGradient>
<radialGradient id="core">
  <stop offset="0" stop-color="#ffb3a8"/><stop offset="0.5" stop-color="#ff6b5a"/>
  <stop offset="1" stop-color="#ff6b5a" stop-opacity="0"/>
</radialGradient>`;

  const parts = [];
  for (const size of [3, 2, 1]) {
    for (const hunter of [false, true]) {
      for (let variant = 0; variant < ASTEROID_VARIANTS; variant += 1) {
        const frame = sheet.frames[asteroidFrameName(size, variant, hunter)];
        const seed = size * 1000 + variant * 37 + (hunter ? 7 : 0);
        parts.push(asteroidFrameSvg(frame, seed, hunter));
      }
    }
  }
  return svgDocument(sheet.width, sheet.height, defs, parts.join('\n'));
}

/**
 * @param {'sprites' | 'asteroids'} sheetId
 * @returns {string} текст SVG-файла
 */
export function buildSpriteSheetSvg(sheetId) {
  const sheet = SPRITE_SHEETS.find((candidate) => candidate.id === sheetId);
  if (!sheet) throw new Error(`Невідомий спрайт-лист: ${sheetId}`);
  return sheetId === 'sprites' ? buildSpritesSvg(sheet) : buildAsteroidsSvg(sheet);
}

/** SVG -> data-URI, придатний для new Image().src без запиту до мережі. */
export function svgToDataUri(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}
