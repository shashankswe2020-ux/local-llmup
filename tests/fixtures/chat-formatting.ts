export const FORMATTING_TRIGGER = "FORMAT_MARKDOWN";
export const FORMATTING_STREAM_TRIGGER = "FORMAT_MARKDOWN_STREAM";
export const FORMATTING_SCROLL_TRIGGER = "FORMAT_MARKDOWN_SCROLL";
export const FORMATTING_INCOMPLETE_TRIGGER = "FORMAT_MARKDOWN_INCOMPLETE";

export const FORMATTING_RESPONSE = `# Deployment result

A useful answer supports **bold**, *emphasis*, ~~removed text~~, and \`inline code\`.

## Checklist

- Parent item
  - Nested child
  - [Documentation](https://example.com/docs?q=local)
- Final item

1. Install dependencies
2. Run the checks

- [x] Build passed
- [ ] Deployment pending

> Important: review this before running commands.
>
> The quote has two paragraphs.

| Check | Status | Duration |
| :--- | :---: | ---: |
| Typecheck | Passed | 1.2s |
| Browser tests | Passed | 7.1s |

---

~~~typescript
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}
~~~

\`\`\`bash
npm run build && npm test
\`\`\`

\`\`\`html
<main class="status">Ready</main>
\`\`\`

Escaped punctuation: \\*literal asterisks\\*.

Long token: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz

Long URL: https://example.com/documentation/guides/local-models/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz

Raw HTML stays inert: <button id="unsafe" onclick="globalThis.__xss = true">unsafe</button><script>globalThis.__xss = true</script>

[Unsafe link](javascript:globalThis.__xss=true)

[Unsafe data link](data:text/html,<script>globalThis.__xss=true</script>)

<svg onload="globalThis.__xss=true"><script>globalThis.__xss=true</script></svg>

<div style="position:fixed;inset:0" onmouseover="globalThis.__xss=true"><img src=x onerror="globalThis.__xss=true"></div>

Malformed HTML: <scr<script>ipt>globalThis.__xss=true</scr</script>ipt>

![Inline image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)

![Local image](formatting.png)

![Remote image](https://example.com/tracker.png)

![File image](file:///tmp/private.png)

![HTML data image](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`;

export const FORMATTING_SCROLL_RESPONSE = Array.from(
  { length: 24 },
  (_, index) => `## Stream section ${index + 1}\n\nA paragraph with **useful detail** and \`inline code\` for the reader.`,
).join("\n\n");

export const FORMATTING_INCOMPLETE_RESPONSE = `Before the code.\n\n\`\`\`typescript\nconst value = 1;\n\`\`\`\n\nAfter the code.`;
