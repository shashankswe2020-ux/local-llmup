// Copy-to-clipboard for all [data-install] containers
document.querySelectorAll("[data-install]").forEach((wrap) => {
  wrap.querySelectorAll(".copy-btn").forEach((btn) => {
    const svg = btn.innerHTML;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(wrap.getAttribute("data-install") || "");
        btn.textContent = "✓";
        btn.style.color = "var(--green)";
        setTimeout(() => { btn.innerHTML = svg; btn.style.color = ""; }, 1500);
      } catch { /* Clipboard may be blocked */ }
    });
  });
});

// Scroll-reveal
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
        observer.unobserve(e.target);
      }
    }
  },
  { threshold: 0.1 }
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
