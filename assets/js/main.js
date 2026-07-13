const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const cursorGlow = document.querySelector(".cursor-glow");
const year = document.getElementById("year");

if (year) year.textContent = new Date().getFullYear();

const updateHeader = () => header?.classList.toggle("scrolled", window.scrollY > 24);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

navToggle?.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(open));
});

document.addEventListener("pointermove", (event) => {
  if (!cursorGlow) return;
  cursorGlow.style.left = `${event.clientX}px`;
  cursorGlow.style.top = `${event.clientY}px`;
});

document.querySelectorAll(".reveal").forEach((node) => node.classList.add("visible"));

document.querySelectorAll("[data-words]").forEach((line) => {
  const words = line.textContent.trim().split(/\s+/);
  line.textContent = "";
  words.forEach((word, index) => {
    const span = document.createElement("span");
    span.textContent = `${word} `;
    span.style.transitionDelay = `${index * 55}ms`;
    line.appendChild(span);
  });
});

const wordObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.querySelectorAll("span").forEach((span) => span.classList.add("visible"));
  });
}, { threshold: .45 });
document.querySelectorAll("[data-words]").forEach((node) => wordObserver.observe(node));

document.querySelectorAll(".tilt-card").forEach((card) => {
  card.addEventListener("pointermove", (event) => {
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    card.style.transform = `rotateX(${-y * 5}deg) rotateY(${x * 5}deg) translateY(-8px)`;
  });
  card.addEventListener("pointerleave", () => {
    card.style.transform = "";
  });
});

const feedbackForm = document.querySelector("[data-feedback-form]");

if (feedbackForm) {
  const params = new URLSearchParams(window.location.search);
  const context = {
    collection: params.get("collection") || "The Human Paradox Collection",
    series: params.get("series") || "",
    book: params.get("book") || "",
    chapter: params.get("chapter") || "",
  };
  const target = context.chapter || context.book || context.series || context.collection;
  const title = document.querySelector("[data-feedback-title]");
  const contextLine = document.querySelector("[data-feedback-context]");
  const status = document.querySelector("[data-feedback-status]");

  Object.entries(context).forEach(([key, value]) => {
    const input = feedbackForm.elements[key];
    if (input) input.value = value;
  });

  if (title) title.textContent = `Feedback for ${target}`;
  if (contextLine) {
    const parts = [context.collection, context.series, context.book, context.chapter].filter(Boolean);
    contextLine.textContent = parts.join(" / ");
  }

  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault(); 
    
    const submitButton = feedbackForm.querySelector("button[type='submit']");
    const status = document.querySelector("[data-feedback-status]");
    const data = new FormData(feedbackForm);
    
    if (submitButton) submitButton.disabled = true;
    if (status) status.textContent = "Sending feedback...";

    try {
      const response = await fetch(feedbackForm.action, {
        method: 'POST',
        body: data,
        headers: {
            'Accept': 'application/json'
        }
      });
      
      if (response.ok) {
        status.textContent = "Thank you! Your feedback has been sent.";
        feedbackForm.reset(); // This clears the form boxes
      } else {
        status.textContent = "Oops! There was a problem submitting your form.";
      }
    } catch (error) {
      status.textContent = "Oops! There was a network problem.";
    }
    
    if (submitButton) submitButton.disabled = false;
  });
}
