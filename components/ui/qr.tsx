import { useMemo } from 'react';
import { create } from 'qrcode';

/**
 * A QR code as this panel draws one: the payload goes in, an SVG path comes out.
 *
 * Baileys' pairing payload is a string, not an image, so the panel owns turning it into pixels and
 * the only question is how. The matrix is read module by module and written as one `d` attribute
 * rather than handed to a renderer that returns markup: a payload from a socket never becomes HTML
 * in this panel, and the drawing survives a print or a screenshot as sharp squares.
 *
 * A payload this encoder cannot draw is drawn as nothing. It is not a failure the owner can fix --
 * the next QR arrives within twenty seconds -- so it must not take the panel down with it.
 */
function modulesOf(value: string): { size: number; path: string } | null {
  try {
    const { modules } = create(value, { errorCorrectionLevel: 'M' });
    const size = modules.size;
    let path = '';
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (modules.get(row, column)) path += `M${column} ${row}h1v1h-1z`;
      }
    }
    return { size, path };
  } catch {
    return null;
  }
}

export function Qr({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const code = useMemo(() => modulesOf(value), [value]);
  if (!code) return null;
  return (
    <svg
      className="ui-qr"
      viewBox={`0 0 ${code.size} ${code.size}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={code.size} height={code.size} fill="#ffffff" />
      <path d={code.path} fill="#000000" />
    </svg>
  );
}
