const revealNodes = Array.from(document.querySelectorAll(".reveal"));

for (const [index, node] of revealNodes.entries()) {
  const seededTwist = ((index * 13) % 5) - 2;
  if (node.classList.contains("card")) {
    node.style.setProperty("--twist", String(seededTwist));
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.18 },
);

for (const node of revealNodes) {
  observer.observe(node);
}
