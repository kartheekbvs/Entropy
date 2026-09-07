// build a portfolio website for kartheek with dark theme

--- PROJECT ME — interactive demo logic
const btn = document.getElementById("go");
const out = document.getElementById("out");
let n = 0;
btn.addEventListener("click", () => {
  n += 1;
  out.textContent = `clicked ${n}× — offline engine works`;
});
