const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const cursorGlow = document.querySelector(".cursor-glow");
const year = document.getElementById("year");
const finePointer = window.matchMedia("(pointer: fine)").matches;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const mainScriptUrl = document.currentScript?.src || new URL("/assets/js/main.js", window.location.href).href;

if (year) year.textContent = new Date().getFullYear();

const updateHeader = () => header?.classList.toggle("scrolled", window.scrollY > 24);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

navToggle?.addEventListener("click", () => {
  if (!nav) return;

  const open = nav.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
});

document.querySelectorAll(".dropdown").forEach((dropdown) => {
  const trigger = dropdown.querySelector(".dropdown-trigger");
  if (!trigger) return;

  const setExpanded = (expanded) => {
    trigger.setAttribute("aria-expanded", String(expanded));
  };

  dropdown.addEventListener("focusin", () => setExpanded(true));
  dropdown.addEventListener("focusout", (event) => {
    if (!dropdown.contains(event.relatedTarget)) setExpanded(false);
  });
  dropdown.addEventListener("pointerenter", () => setExpanded(true));
  dropdown.addEventListener("pointerleave", () => setExpanded(false));
});

if (cursorGlow && finePointer && !reducedMotion) {
  document.addEventListener("pointermove", (event) => {
    cursorGlow.style.left = `${event.clientX}px`;
    cursorGlow.style.top = `${event.clientY}px`;
  });
}

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
  if (!finePointer || reducedMotion) return;
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
  const loadFeedbackModule = () => import(new URL("feedback-submission.js", mainScriptUrl).href);
  const context = {
    collection: params.get("collection") || "The Human Paradox Collection",
    series: params.get("series") || "",
    book: params.get("book") || "",
  };
  const title = document.querySelector("[data-feedback-title]");
  const contextLine = document.querySelector("[data-feedback-context]");
  const status = document.querySelector("[data-feedback-status]");
  const formatContext = (value) => value.replace(/\s+-\s+/g, " \u2014 ");
  const setFeedbackStatus = (message = "", type = "") => {
    if (!status) return;
    status.textContent = message;
    status.dataset.status = type;
  };
  const setSubmitState = (button, busy) => {
    if (!button) return;
    if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? "Sending feedback..." : button.dataset.defaultLabel;
  };
  const logFeedbackError = (error) => {
    console.error("Feedback submission failed", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
      status: error?.status,
    });
  };

  Object.entries(context).forEach(([key, value]) => {
    const input = feedbackForm.elements[key];
    if (input) input.value = value;
  });

  if (title) title.textContent = "Share Your Feedback";
  if (contextLine) {
    const parts = [context.collection, context.series, context.book].filter(Boolean);
    contextLine.textContent = "";
    parts.forEach((part) => {
      const line = document.createElement("span");
      line.textContent = formatContext(part);
      contextLine.appendChild(line);
    });
  }

  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault(); 
    
    const submitButton = feedbackForm.querySelector("button[type='submit']");
    if (feedbackForm.dataset.submitting === "true") return;

    if (!feedbackForm.checkValidity()) {
      setFeedbackStatus("Please complete the required fields.", "error");
      feedbackForm.reportValidity();
      return;
    }

    feedbackForm.dataset.submitting = "true";
    setSubmitState(submitButton, true);
    setFeedbackStatus("Sending feedback...", "info");

    try {
      const { clearFeedbackEntryFields, submitFeedback } = await loadFeedbackModule();
      await submitFeedback(feedbackForm);
      setFeedbackStatus("Thank you! Your feedback has been sent.", "success");
      clearFeedbackEntryFields(feedbackForm);
    } catch (error) {
      logFeedbackError(error);
      setFeedbackStatus("We could not save your feedback right now. Please try again.", "error");
    } finally {
      delete feedbackForm.dataset.submitting;
      setSubmitState(submitButton, false);
    }
  });
}
