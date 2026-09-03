(() => {
  const display = document.querySelector("#display");
  const status = document.querySelector("#status");
  const allowed = /^[0-9+\-*/().\s]+$/;

  if (!display || !status) {
    return;
  }

  function setError(message) {
    status.textContent = message;
  }

  function append(value) {
    if (display.value === "0" && /[0-9.]/.test(value)) {
      display.value = value;
    } else {
      display.value += value;
    }
    setError("");
  }

  function evaluate() {
    const expression = display.value.trim();
    if (!expression || !allowed.test(expression)) {
      setError("Use numbers and + - * / only.");
      return;
    }
    try {
      const result = parseExpression(expression);
      if (typeof result !== "number" || !Number.isFinite(result)) {
        throw new Error("not finite");
      }
      display.value = String(result);
      setError("");
    } catch {
      setError("That expression cannot be calculated.");
    }
  }

  function parseExpression(source) {
    let index = 0;
    function skip() {
      while (index < source.length && source[index] === " ") index += 1;
    }
    function parseNumber() {
      skip();
      const start = index;
      while (index < source.length && /[0-9.]/.test(source[index])) index += 1;
      const value = Number(source.slice(start, index));
      if (!Number.isFinite(value)) throw new Error("bad number");
      return value;
    }
    function parseFactor() {
      skip();
      if (source[index] === "(") {
        index += 1;
        const value = parseAddSub();
        skip();
        if (source[index] !== ")") throw new Error("missing )");
        index += 1;
        return value;
      }
      if (source[index] === "-") {
        index += 1;
        return -parseFactor();
      }
      if (source[index] === "+") {
        index += 1;
        return parseFactor();
      }
      return parseNumber();
    }
    function parseMulDiv() {
      let value = parseFactor();
      skip();
      while (source[index] === "*" || source[index] === "/") {
        const op = source[index];
        index += 1;
        const rhs = parseFactor();
        value = op === "*" ? value * rhs : value / rhs;
        skip();
      }
      return value;
    }
    function parseAddSub() {
      let value = parseMulDiv();
      skip();
      while (source[index] === "+" || source[index] === "-") {
        const op = source[index];
        index += 1;
        const rhs = parseMulDiv();
        value = op === "+" ? value + rhs : value - rhs;
        skip();
      }
      return value;
    }
    const result = parseAddSub();
    skip();
    if (index !== source.length) throw new Error("trailing input");
    return result;
  }

  document.querySelector(".keys")?.addEventListener("click", (event) => {
    const target = event.target;
    const button = target && typeof target.closest === "function" ? target.closest("button") : null;
    if (!button || typeof button.dataset !== "object") {
      return;
    }
    if (button.dataset.action === "clear") {
      display.value = "0";
      setError("");
      return;
    }
    if (button.dataset.action === "backspace") {
      display.value = display.value.slice(0, -1) || "0";
      setError("");
      return;
    }
    if (button.dataset.action === "evaluate") {
      evaluate();
      return;
    }
    append(button.dataset.value ?? "");
  });

  display.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      evaluate();
    }
  });
})();