/**
 * Template Engine for Context Interpolation
 * 
 * Resolves {{path.to.value}} placeholders in strings using a context object.
 * Supports nested paths like "input.customer.name" or "steps.create_ticket.raw.id".
 */

/**
 * Get a nested property from an object by dot-separated path.
 * 
 * @param obj - The object to traverse
 * @param path - Dot-separated path like "a.b.c"
 * @returns The value at the path, or undefined if not found
 * 
 * @example
 * getPath({ a: { b: { c: 42 } } }, "a.b.c") // => 42
 * getPath({ items: [1, 2, 3] }, "items.1")  // => 2
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
    
    // Handle array index access (e.g., "items.0")
    if (Array.isArray(current)) {
      const index = parseInt(segment, 10);
      if (!isNaN(index)) {
        current = current[index];
        continue;
      }
    }
    
    // Handle object property access
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  
  return current;
}

/**
 * Resolve {{...}} placeholders in a string using context.
 * 
 * @param template - String with {{path}} placeholders
 * @param context - Context object to resolve paths from
 * @returns String with placeholders replaced by values
 * 
 * @example
 * resolveStringTemplate("Hello {{input.name}}!", { input: { name: "World" } })
 * // => "Hello World!"
 */
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
    
    // For objects/arrays, stringify them
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    
    return String(value);
  });
}

/**
 * Deep-resolve templates in any value (object, array, string, etc.).
 * 
 * @param value - Value to resolve templates in
 * @param context - Context object to resolve paths from
 * @returns Value with all string templates resolved
 * 
 * @example
 * resolveTemplate(
 *   { title: "Hello {{input.name}}", count: 5 },
 *   { input: { name: "World" } }
 * )
 * // => { title: "Hello World", count: 5 }
 */
export function resolveTemplate<T>(
  value: T,
  context: Record<string, unknown>
): T {
  // String: resolve placeholders
  if (typeof value === "string") {
    return resolveStringTemplate(value, context) as unknown as T;
  }
  
  // Array: recursively resolve each element
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplate(v, context)) as unknown as T;
  }
  
  // Object: recursively resolve each property
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveTemplate(val, context);
    }
    return result as unknown as T;
  }
  
  // Primitives (number, boolean, null, undefined): return as-is
  return value;
}

