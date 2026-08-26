/**
 * Service facade over the library store used by the GUI server: CRUD for agents
 * and skills plus composing the per-message system prompt. Create derives a
 * unique kebab-case id from the display name; update merges a partial payload
 * onto the stored item. `composeForChat` loads only enabled items.
 */
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { composeSystemPrompt } from "./compose.js";
import {
  LIBRARY_ID_RE,
  LibraryDraftSchema,
  LibraryUpdateSchema,
  slugify,
  type LibraryDraft,
  type LibraryItem,
  type LibraryKind,
  type LibraryUpdate,
} from "./schema.js";
import { deleteItem, itemExists, listItems, readItem, writeItem } from "./store.js";

/** CRUD + chat composition over the on-disk agent and skill libraries. */
export interface LibraryService {
  list(kind: LibraryKind): LibraryItem[];
  get(kind: LibraryKind, id: string): LibraryItem | undefined;
  create(kind: LibraryKind, draft: LibraryDraft): LibraryItem;
  update(kind: LibraryKind, id: string, patch: LibraryUpdate): LibraryItem;
  remove(kind: LibraryKind, id: string): void;
  /** Compose the system prompt for a chat turn from an agent + skill selection. */
  composeForChat(
    agentId: string | undefined,
    skillIds: readonly string[] | undefined,
  ): string | undefined;
}

function uniqueId(config: Config, kind: LibraryKind, name: string): string {
  const base = slugify(name);
  if (!itemExists(config, kind, base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 64).replace(/-+$/g, "");
    if (!itemExists(config, kind, candidate)) return candidate;
  }
  throw new ValidationError(`too many ${kind}s named like "${name}"`);
}

/** Construct a {@link LibraryService} bound to a config (defaults to loadConfig). */
export function createLibraryService(config: Config = loadConfig()): LibraryService {
  return {
    list(kind) {
      return listItems(config, kind);
    },
    get(kind, id) {
      return readItem(config, kind, id);
    },
    create(kind, draft) {
      const parsed = LibraryDraftSchema.parse(draft);
      const id = uniqueId(config, kind, parsed.name);
      const item: LibraryItem = {
        id,
        name: parsed.name,
        description: parsed.description ?? "",
        enabled: parsed.enabled ?? true,
        body: parsed.body ?? "",
        skills: (parsed.skills ?? []).filter((skillId) => LIBRARY_ID_RE.test(skillId)),
      };
      writeItem(config, kind, item);
      return item;
    },
    update(kind, id, patch) {
      const parsed = LibraryUpdateSchema.parse(patch);
      const existing = readItem(config, kind, id);
      if (existing === undefined) {
        throw new ValidationError(`${kind} not found: ${id}`);
      }
      const item: LibraryItem = {
        id: existing.id,
        name: parsed.name ?? existing.name,
        description: parsed.description ?? existing.description,
        enabled: parsed.enabled ?? existing.enabled,
        body: parsed.body ?? existing.body,
        skills:
          parsed.skills !== undefined
            ? parsed.skills.filter((skillId) => LIBRARY_ID_RE.test(skillId))
            : existing.skills,
      };
      writeItem(config, kind, item);
      return item;
    },
    remove(kind, id) {
      if (readItem(config, kind, id) === undefined) {
        throw new ValidationError(`${kind} not found: ${id}`);
      }
      deleteItem(config, kind, id);
    },
    composeForChat(agentId, skillIds) {
      const agent =
        agentId !== undefined && agentId.length > 0 ? readItem(config, "agent", agentId) : undefined;
      const usableAgent = agent !== undefined && agent.enabled ? agent : undefined;

      const orderedSkillIds: string[] = [];
      const seen = new Set<string>();
      const addSkillId = (skillId: string): void => {
        if (!seen.has(skillId)) {
          seen.add(skillId);
          orderedSkillIds.push(skillId);
        }
      };
      if (usableAgent !== undefined) usableAgent.skills.forEach(addSkillId);
      (skillIds ?? []).forEach(addSkillId);

      const skills: LibraryItem[] = [];
      for (const skillId of orderedSkillIds) {
        const skill = readItem(config, "skill", skillId);
        if (skill !== undefined && skill.enabled) skills.push(skill);
      }
      return composeSystemPrompt(usableAgent, skills);
    },
  };
}
