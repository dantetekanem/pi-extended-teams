import { Type } from "@sinclair/typebox";

/**
 * Creates a Google-compatible string enum schema using this package's TypeBox
 * instance. The upstream `@mariozechner/pi-ai` helper can resolve to a
 * different TypeBox instance in this package, which makes `Type.Optional()`
 * reject its `TUnsafe` type at compile time.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
