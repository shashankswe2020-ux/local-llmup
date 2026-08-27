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

// Compact navigation for touch devices and narrower windows
(() => {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.getElementById("site-nav");
  if (!toggle || !links) return;

  const closeMenu = () => {
    links.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation");
  };

  toggle.addEventListener("click", () => {
    const willOpen = toggle.getAttribute("aria-expanded") !== "true";
    links.classList.toggle("is-open", willOpen);
    toggle.setAttribute("aria-expanded", String(willOpen));
    toggle.setAttribute("aria-label", willOpen ? "Close navigation" : "Open navigation");
  });
  links.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!links.contains(event.target) && !toggle.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      toggle.focus();
    }
  });
  globalThis.addEventListener("resize", () => {
    if (globalThis.innerWidth > 1100) closeMenu();
  });
})();

// Desktop installer: platform dropdown + OS-aware primary button
(() => {
  const toggle = document.getElementById("dl-toggle");
  const menu = document.getElementById("dl-menu");
  if (!toggle || !menu) return;

  const closeMenu = () => {
    menu.setAttribute("hidden", "");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hasAttribute("hidden")) {
      menu.removeAttribute("hidden");
      toggle.setAttribute("aria-expanded", "true");
    } else {
      closeMenu();
    }
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== toggle) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  // Point the primary button at the visitor's platform.
  const ua = (navigator.userAgent || navigator.platform || "").toLowerCase();
  let os = "mac";
  if (ua.includes("win")) os = "win";
  else if (ua.includes("linux") && !ua.includes("android")) os = "linux";

  const item = menu.querySelector(`.installer-item[data-os="${os}"]`);
  const main = document.getElementById("dl-main");
  const ic = document.getElementById("dl-main-ic");
  const title = document.getElementById("dl-main-title");
  const sub = document.getElementById("dl-main-sub");
  if (item && main && ic && title && sub) {
    const label = { mac: "Download for macOS", win: "Download for Windows", linux: "Download for Linux" }[os];
    main.href = item.href;
    ic.innerHTML = item.querySelector(".os-ic").innerHTML;
    title.textContent = label;
    sub.textContent = item.querySelector(".installer-item-text span").textContent;
  }
})();
