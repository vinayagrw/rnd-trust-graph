/**
 * Brace-balanced partial-JSON scanner — shared by every streaming composer.
 *
 * Recovers every FULLY-CLOSED object from a growing `"<arrayKey>":[…]` buffer.
 * An object whose closing brace has not yet arrived is never returned (draw-
 * nothing preserved). Tolerates a leading `{ "title": …, "<arrayKey>": [` prefix,
 * ``` fences, and trailing partial content.
 *
 * Extracted from `bff/src/dashboards/composer.ts`'s `extractCompleteWidgets` so
 * the dashboards composer (`widgets`) and the Generative Studio composer
 * (`tiles`) share one implementation instead of two copies drifting apart.
 */
export function extractCompleteObjects(buffer: string, arrayKey: string): unknown[] {
  const cleaned = buffer.replace(/```(?:json)?/gi, "");
  const key = cleaned.indexOf(`"${arrayKey}"`);
  if (key === -1) return [];
  const arrStart = cleaned.indexOf("[", key);
  if (arrStart === -1) return [];
  const out: unknown[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) objStart = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { out.push(JSON.parse(cleaned.slice(objStart, i + 1))); } catch { /* malformed — skip */ }
        objStart = -1;
      }
    } else if (c === "]" && depth === 0) break; // array closed
  }
  return out;
}
