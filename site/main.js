const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Copy buttons: the nearest [data-copy] holds the exact command.
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = btn.closest("[data-copy]")?.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("done");
      }, 1600);
    } catch {
      btn.textContent = "Select";
    }
  });
});

// Mobile navigation
(() => {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.getElementById("site-nav");
  if (!toggle || !links) return;
  const setOpen = (open) => {
    links.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  links.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && links.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
})();

// Accessible tabs with arrow-key navigation
document.querySelectorAll("[data-tabs]").forEach((root) => {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
});

// Highlight the download that matches this visitor and point the hero button at it.
(() => {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  let os = null;
  let label = null;
  if (platform.includes("win") || ua.includes("windows")) [os, label] = ["win", "Windows"];
  else if (platform.includes("mac") || ua.includes("mac os")) [os, label] = ["mac-arm", "macOS"];
  else if (ua.includes("linux") && !ua.includes("android")) {
    [os, label] = [ua.includes("aarch64") || ua.includes("arm64") ? "linux-arm" : "linux-x64", "Linux"];
  }
  const card = os && document.querySelector(`.dl[data-os="${os}"]`);
  if (!card) return;
  card.classList.add("is-current");
  const hero = document.querySelector('.hero-actions a[href="#install"]');
  if (hero) hero.textContent = `Download for ${label}`;
})();

// Respect reduced motion for the autoplaying demo.
if (reduceMotion) {
  document.querySelectorAll("video[autoplay]").forEach((video) => {
    video.removeAttribute("autoplay");
    video.pause();
  });
}

// Gentle reveal, only when motion is welcome.
if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  document
    .querySelectorAll(".section-head, .card, .terminal, .tabs, .downloads, .commands, .faq, .cta, .gallery, .table-scroll")
    .forEach((el) => {
      el.classList.add("reveal");
      observer.observe(el);
    });
}
