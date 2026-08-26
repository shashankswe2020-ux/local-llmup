/**
 * Compose a single system prompt from a selected agent and skills. The agent's
 * body sets the persona; each skill is appended under a heading so the model can
 * apply them as auxiliary instructions. Empty bodies are ignored, and a
 * selection with nothing usable yields `undefined` (no system message is sent).
 */
import type { LibraryItem } from "./schema.js";

/** Build the system prompt, or `undefined` when there is nothing to inject. */
export function composeSystemPrompt(
  agent: LibraryItem | undefined,
  skills: readonly LibraryItem[],
): string | undefined {
  const parts: string[] = [];

  if (agent !== undefined && agent.body.trim().length > 0) {
    parts.push(agent.body.trim());
  }

  const usableSkills = skills.filter((skill) => skill.body.trim().length > 0);
  if (usableSkills.length > 0) {
    const rendered = usableSkills
      .map((skill) => `## ${skill.name}\n${skill.body.trim()}`)
      .join("\n\n");
    parts.push(`# Skills\nApply these skills when relevant:\n\n${rendered}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
