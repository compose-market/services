/**
 * Template Engine
 * 
 * Resolves {{path.to.value}} placeholders in strings and objects.
 */

export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;

  const segments = path
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);

  let current: unknown = obj;

  for (const segment of segments) {
    if (current == null) return undefined;

    if (Array.isArray(current)) {
      const index = parseInt(segment, 10);
      if (!isNaN(index)) {
        current = current[index];
        continue;
      }
    }

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return current;
}

export function resolveStringTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  const regex = /\{\{\s*([^}]+)\s*\}\}/g;

  return template.replace(regex, (_match, path: string) => {
    const value = getPath(context, path.trim());

    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  });
}

export function resolveTemplate<T>(
  value: T,
  context: Record<string, unknown>
): T {
  if (typeof value === "string") {
    return resolveStringTemplate(value, context) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplate(v, context)) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[key] = resolveTemplate(val, context);
    }
    return result as unknown as T;
  }

  return value;
}

