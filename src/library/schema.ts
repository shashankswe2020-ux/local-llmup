/**
 * Validation and identity helpers for library items — agents (persona/system
 * prompts) and skills (reusable instruction blocks). Both share one flat shape;
 * the {@link LibraryKind} distinguishes on-disk layout, not structure.
 */
import { z } from "zod";

/** Which library a document belongs to. */
export type LibraryKind = "agent" | "skill";

/** Upper bound on a document body (system prompt / instructions). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Stable, filesystem-safe identifier (kebab-case slug). */
export const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A fully resolved library item as returned to callers and the UI. */
export const LibraryItemSchema = z
  .object({
    id: z.string().regex(LIBRARY_ID_RE),
    name: z.string().min(1).max(120),
    description: z.string().max(500),
    enabled: z.boolean(),
    body: z.string().max(MAX_BODY_BYTES),
    /** Skill ids an agent always loads (empty for skills themselves). */
    skills: z.array(z.string().regex(LIBRARY_ID_RE)).max(50).default([]),
  })
  .strict();

export type LibraryItem = z.infer<typeof LibraryItemSchema>;

/** Create/update payload accepted from the GUI. `id` is derived, never trusted. */
export const LibraryDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    body: z.string().max(MAX_BODY_BYTES).optional(),
    enabled: z.boolean().optional(),
    skills: z.array(z.string().trim().max(64)).max(50).optional(),
  })
  .strict();

export type LibraryDraft = z.infer<typeof LibraryDraftSchema>;

/** Partial update payload: every field optional so a toggle can send only `enabled`. */
export const LibraryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    body: z.string().max(MAX_BODY_BYTES).optional(),
    enabled: z.boolean().optional(),
    skills: z.array(z.string().trim().max(64)).max(50).optional(),
  })
  .strict();

export type LibraryUpdate = z.infer<typeof LibraryUpdateSchema>;

/**
 * Derive a kebab-case slug from a display name. Non-alphanumeric runs collapse
 * to single hyphens; the result is bounded to 64 chars and guaranteed to match
 * {@link LIBRARY_ID_RE}. Names that reduce to nothing fall back to `item`.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return LIBRARY_ID_RE.test(slug) ? slug : "item";
}
