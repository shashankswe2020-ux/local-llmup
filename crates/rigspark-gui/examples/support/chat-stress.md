# Response rendering stress

Mixed scripts stay intact: café · Ελληνικά · العربية · हिन्दी · বাংলা · 日本語 · 汉字 · 한글.

Emoji modifiers stay intact: 👩🏽 🚀 🏳️ ✅.

Long prose token: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz.

Safe URL: [documentation](https://example.com/a/very/long/path/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz?mode=stress&view=chat).

- Level one
  - Level two
    - Level three with `inline_code_that_is_intentionally_long_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz`
      - Level four

| Alpha | Beta | Gamma | Delta | Epsilon | Zeta | Eta | Theta |
| --- | --- | --- | --- | --- | --- | --- | --- |
| one | two | three | four | five | six | seven | eight |
| abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz |

```text
unicode: café → 🚀 汉字 العربية
long-line: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz
```

$$
\boxed{\frac{1}{2} + \sqrt{x^2 + y^2} + \sum_{n=1}^{100} n + \prod_{k=1}^{20} k + \int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}}
$$

![Inline pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)

Unsafe HTML stays inert: <iframe src="https://example.com"></iframe><div style="position:fixed;inset:0" onclick="globalThis.__stressXss=true">blocked</div>

Malformed delimiters stay readable: $$ unmatched display and \(unmatched inline.