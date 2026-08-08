const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const cursorGlow = document.querySelector(".cursor-glow");
const year = document.getElementById("year");
const finePointer = window.matchMedia("(pointer: fine)").matches;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const mainScriptUrl = document.currentScript?.src || new URL("/assets/js/main.js", window.location.href).href;
const loginPath = "/auth/login/";
const accountPath = "/account/";
const adminPath = "/admin/";
const adminRoles = new Set(["admin", "super_admin"]);

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

const createAuthLink = (href, text, className = "") => {
  const link = document.createElement("a");
  link.href = href;
  if (className) link.className = className;
  link.textContent = text;
  return link;
};

const renderLoginNav = (slot) => {
  slot.replaceChildren(createAuthLink(loginPath, "Log in", "auth-nav__login"));
};

const renderProfileNav = (slot, user, profile, authModule) => {
  const role = profile?.role || "customer";
  const details = document.createElement("details");
  details.className = "auth-menu";

  const summary = document.createElement("summary");
  summary.textContent = profile?.display_name
    || user?.user_metadata?.display_name
    || user?.email?.split("@")[0]
    || "My Account";

  const panel = document.createElement("div");
  panel.className = "auth-menu__panel";
  panel.append(createAuthLink(accountPath, "My Account"));

  if (adminRoles.has(role)) {
    panel.append(createAuthLink(adminPath, "Admin Portal"));
  }

  const logout = document.createElement("button");
  logout.type = "button";
  logout.textContent = "Logout";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    logout.textContent = "Logging out...";
    try {
      await authModule.signOut();
      window.location.assign(loginPath);
    } catch (error) {
      console.error("Navigation logout failed", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
      });
      logout.disabled = false;
      logout.textContent = "Logout";
    }
  });

  panel.append(logout);
  details.append(summary, panel);
  slot.replaceChildren(details);
};

const initAuthNavigation = async () => {
  const navs = Array.from(document.querySelectorAll("[data-nav]"));
  if (!navs.length) return;

  const slots = navs.map((navNode) => {
    const existing = navNode.querySelector("[data-auth-nav]");
    if (existing) return existing;

    const slot = document.createElement("div");
    slot.className = "auth-nav";
    slot.dataset.authNav = "";
    slot.setAttribute("aria-live", "polite");
    renderLoginNav(slot);
    navNode.append(slot);
    return slot;
  });

  try {
    const authModule = await import(new URL("auth.js", mainScriptUrl).href);
    const user = await authModule.getCurrentUser();

    if (!user) {
      slots.forEach(renderLoginNav);
      return;
    }

    const profile = await authModule.getCurrentProfile(user);
    slots.forEach((slot) => renderProfileNav(slot, user, profile, authModule));
  } catch (error) {
    console.info("Navigation auth state could not be loaded.", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
    slots.forEach(renderLoginNav);
  }
};

const slugFromHref = (href, kind) => {
  if (!href) return "";

  const url = new URL(href, window.location.href);
  const segments = url.pathname.split("/").filter(Boolean);

  if (kind === "book") {
    const file = segments.at(-1) || "";
    return file.endsWith(".html") ? file.replace(/\.html$/, "") : "";
  }

  if (kind === "series") {
    const projectIndex = segments.indexOf("projects");
    return projectIndex >= 0 ? segments[projectIndex + 1] || "" : "";
  }

  return "";
};

const contentCardInfo = (card) => {
  if (card.matches(".book-card")) {
    const href = card.querySelector("a[href*='books/']")?.getAttribute("href") || "";
    return { kind: "book", slug: slugFromHref(href, "book") };
  }

  if (card.matches(".project-card")) {
    const href = card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || "";
    return { kind: "series", slug: slugFromHref(href, "series") };
  }

  return { kind: "", slug: "" };
};

const initContentVisibilityFiltering = async () => {
  const cards = Array.from(document.querySelectorAll(".project-card, .book-card"));
  if (!cards.length) return;

  try {
    const access = await import(new URL("content-access.js", mainScriptUrl).href);
    const context = await access.getAccessContext();

    if (access.isAdminRole(context.role)) return;

    const hierarchy = await access.fetchContentHierarchy();
    const blockingError = hierarchy.errors.collections || hierarchy.errors.series || hierarchy.errors.books;

    if (blockingError) {
      console.info("Content visibility filtering is waiting on Supabase hierarchy schema/RLS.", {
        collections: hierarchy.errors.collections?.message,
        series: hierarchy.errors.series?.message,
        books: hierarchy.errors.books?.message,
      });
      return;
    }

    const seriesBySlug = new Map(hierarchy.seriesItems.map((item) => [item.slug, item]));
    const booksBySlug = new Map(hierarchy.books.map((item) => [item.slug, item]));

    cards.forEach((card) => {
      const { kind, slug } = contentCardInfo(card);
      if (!kind || !slug) return;

      const hierarchyItem = kind === "book"
        ? access.hierarchyForBook(booksBySlug.get(slug), hierarchy.seriesItems, hierarchy.collections)
        : {
            collection: access.collectionForSeries(seriesBySlug.get(slug), hierarchy.collections),
            series: seriesBySlug.get(slug),
          };

      if (!access.canDiscoverContent(hierarchyItem, context)) {
        card.remove();
      }
    });
  } catch (error) {
    console.info("Content visibility filtering could not run.", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
  }
};

initAuthNavigation();
initContentVisibilityFiltering();

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
