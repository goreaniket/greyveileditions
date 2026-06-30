import { supabase } from "./supabase.js";
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

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add("visible");
  });
}, { threshold: .16 });
document.querySelectorAll(".reveal").forEach((node) => revealObserver.observe(node));

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
    const data = new FormData(feedbackForm);
    const name = data.get("name")?.toString().trim();
    const email = data.get("email")?.toString().trim();
    const message = data.get("message")?.toString().trim();
    const payload = {
      collection: context.collection,
      series: context.series,
      book: context.book,
      chapter: context.chapter,
      feedback_type: context.chapter ? "chapter" : context.book ? "book" : context.series ? "series" : "collection",
      reader_name: name,
      reader_email: email,
      message,
      page_url: window.location.href,
    };

    if (!name || !message) return;
    if (status) status.textContent = "Sending feedback...";
    if (submitButton) submitButton.disabled = true;

    const attempts = [
      payload,
      { collection: payload.collection, series: payload.series, book: payload.book, chapter: payload.chapter, name, email, message },
      { name, email, message: `${contextLine?.textContent || target}\n\n${message}` },
    ];

    let lastError;
    for (const attempt of attempts) {
      const { error } = await supabase.from("reader_feedback").insert([attempt]);
      if (!error) {
        feedbackForm.reset();
        if (status) status.textContent = "Thank you. Your feedback has been sent.";
        if (submitButton) submitButton.disabled = false;
        return;
      }
      lastError = error;
    }

    console.error("Feedback submission failed:", lastError);
    if (status) status.textContent = "Feedback could not be sent right now. Please try again later.";
    if (submitButton) submitButton.disabled = false;
  });
}
