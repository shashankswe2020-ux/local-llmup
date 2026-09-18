# Browser Dependencies

Native builds embed these exact browser distributions. No npm install, CDN, or
Node process is needed to build or run the Rust GUI or Tauri app.

| Library | Version | Upstream | SHA-256 |
| --- | --- | --- | --- |
| Marked | 15.0.12 | https://github.com/markedjs/marked | `3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c` |
| DOMPurify | 3.4.13 | https://github.com/cure53/DOMPurify | `9ab3d44d73c3e3947f9ab72e0f0bc15c7f1931d60b365ba261fc85fe59013c56` |

Files were copied without modification from the existing pinned project packages.
Upstream license notices are retained beside them. Include these notices with
native distributions. Any update requires security review, hash updates, and
browser rendering/sanitization regression checks. These are browser scripts,
not a JavaScript backend or an npm launcher.