const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const cursorGlow = document.querySelector(".cursor-glow");
const year = document.getElementById("year");
const currentCopyrightYear = "2026";
const finePointer = window.matchMedia("(pointer: fine)").matches;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const mainScriptUrl = document.currentScript?.src || new URL("/assets/js/main.js", window.location.href).href;
const loginPath = "/auth/login/";
const accountPath = "/account/";
const adminPath = "/admin/";
const adminRoles = new Set(["admin", "super_admin"]);

document.body.dataset.accessState = "resolving";

if (year) year.textContent = currentCopyrightYear;

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

const renderPendingNav = (slot) => {
  const pending = document.createElement("span");
  pending.className = "auth-nav__login";
  pending.textContent = "Account";
  pending.setAttribute("aria-busy", "true");
  slot.replaceChildren(pending);
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
    renderLoginNav(slot);
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
      renderProfileNav(slot, user, profile, authModule);
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

  slots.forEach(renderPendingNav);

  try {
    const authModule = await import(new URL("auth.js", mainScriptUrl).href);
    const user = await authModule.getCurrentUser();

    if (!user) {
      slots.forEach(renderLoginNav);
      return {
        user: null,
        profile: null,
        role: "guest",
      };
    }

    const profile = await authModule.getCurrentProfile(user);
    slots.forEach((slot) => renderProfileNav(slot, user, profile, authModule));
    return {
      user,
      profile,
      role: profile?.role || "customer",
    };
  } catch (error) {
    console.info("Navigation auth state could not be loaded.", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
    slots.forEach(renderLoginNav);
    return {
      user: null,
      profile: null,
      role: "guest",
    };
  }
};

let contentSurfaceRecords = null;
let contentVisibilityRun = 0;
let authRefreshTimer = 0;

const setAccessPending = () => {
  document.body.dataset.accessState = "resolving";
};

const setAccessResolved = (runId) => {
  if (runId === contentVisibilityRun) {
    document.body.dataset.accessState = "resolved";
  }
};

const directContentState = {
  target: null,
  main: null,
  footer: null,
  title: document.title,
  descriptionNode: document.querySelector("meta[name='description']"),
  description: document.querySelector("meta[name='description']")?.getAttribute("content") || "",
  mainNodes: null,
  footerHidden: false,
  footerCaptured: false,
  unavailable: false,
};

const slugifyContent = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const parseContentTarget = (href) => {
  if (!href) return "";

  const url = new URL(href, window.location.href);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectIndex = segments.indexOf("projects");
  if (projectIndex < 0) return { kind: "", slug: "" };

  const booksIndex = segments.indexOf("books");
  if (booksIndex >= 0) {
    const rawSlug = segments[booksIndex + 1] || "";
    const slug = rawSlug.endsWith(".html") ? rawSlug.replace(/\.html$/, "") : rawSlug;
    return { kind: slug ? "book" : "", slug };
  }

  const seriesSlug = segments[projectIndex + 1] || "";
  if (seriesSlug && seriesSlug !== "index.html") {
    return { kind: "series", slug: seriesSlug };
  }

  return { kind: "", slug: "" };
};

const targetFromLink = (link) => {
  const target = parseContentTarget(link.getAttribute("href"));
  if (hasContentTarget(target)) return target;

  const url = new URL(link.getAttribute("href") || "", window.location.href);
  const segments = url.pathname.split("/").filter(Boolean);
  const isProjectsRoot = segments[0] === "projects" && (segments.length === 1 || segments[1] === "index.html");
  const label = link.textContent.trim();

  if (isProjectsRoot && /collection/i.test(label)) {
    return { kind: "collection", slug: slugifyContent(label), title: label };
  }

  return { kind: "", slug: "" };
};

const contentCardInfo = (card) => {
  if (card.matches(".book-card")) {
    const href = card.querySelector("a[href*='books/']")?.getAttribute("href") || "";
    return parseContentTarget(href);
  }

  if (card.matches(".project-card")) {
    const href = card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || "";
    return parseContentTarget(href);
  }

  return { kind: "", slug: "" };
};

const currentPageTarget = () => {
  const main = document.querySelector("main");
  const target = parseContentTarget(window.location.href);
  if (target.kind === "book" && main?.classList.contains("book-detail")) return target;
  if (target.kind === "series" && document.body.classList.contains("series-landing")) return target;

  const segments = window.location.pathname.split("/").filter(Boolean);
  const isProjectsRoot = segments[0] === "projects" && (segments.length === 1 || segments[1] === "index.html");
  const heading = isProjectsRoot ? document.querySelector("main h1")?.textContent.trim() : "";
  if (heading && /collection/i.test(heading)) {
    return { kind: "collection", slug: slugifyContent(heading), title: heading };
  }

  return { kind: "", slug: "" };
};

const hasContentTarget = (target) => Boolean(target?.kind && target?.slug);

const collectContentSurfaceRecords = () => {
  if (contentSurfaceRecords) return contentSurfaceRecords;

  const records = [];
  const seen = new Set();
  const addRecord = (node, target) => {
    if (!node || !hasContentTarget(target) || seen.has(node)) return;
    seen.add(node);
    records.push({
      node,
      target,
      placeholder: null,
      detached: false,
    });
  };

  document.querySelectorAll(".project-card, .book-card").forEach((card) => {
    addRecord(card, contentCardInfo(card));
  });

  document.querySelectorAll("a[href]").forEach((link) => {
    if (link.closest(".project-card, .book-card")) return;
    const target = targetFromLink(link);
    if (!hasContentTarget(target)) return;
    addRecord(link, target);
  });

  contentSurfaceRecords = records;
  return records;
};

const suspendNode = (node) => {
  if (!node?.isConnected) return;
  node.hidden = true;
  if ("inert" in node) node.inert = true;
};

const suspendDirectNode = (node) => {
  if (!node?.isConnected) return;
  node.dataset.accessPending = "";
  node.setAttribute("aria-busy", "true");
  if ("inert" in node) node.inert = true;
};

const revealNode = (node) => {
  if (!node) return;
  node.hidden = false;
  delete node.dataset.accessPending;
  node.removeAttribute("aria-busy");
  if ("inert" in node) node.inert = false;
};

const detachRecord = (record) => {
  if (!record.placeholder) {
    record.placeholder = document.createComment("greyveil-filtered-content");
  }

  if (record.node.isConnected && !record.placeholder.isConnected) {
    record.node.before(record.placeholder);
  }

  record.node.remove();
  record.detached = true;
};

const attachRecord = (record) => {
  if (record.detached && record.placeholder?.parentNode) {
    record.placeholder.parentNode.insertBefore(record.node, record.placeholder);
  }

  record.detached = false;
  revealNode(record.node);
};

const suspendRecord = (record) => {
  if (!record.detached) suspendNode(record.node);
};

const suspendDirectContent = () => {
  const target = currentPageTarget();
  if (!hasContentTarget(target)) return null;

  const main = document.querySelector("main");
  if (!main) return target;

  directContentState.target = target;
  directContentState.main = main;
  directContentState.footer = document.querySelector(".site-footer");
  directContentState.title = directContentState.title || document.title;
  directContentState.descriptionNode = directContentState.descriptionNode || document.querySelector("meta[name='description']");
  directContentState.description = directContentState.description || directContentState.descriptionNode?.getAttribute("content") || "";
  if (!directContentState.mainNodes) {
    directContentState.mainNodes = Array.from(main.childNodes);
  }

  suspendDirectNode(main);
  if (directContentState.footer) {
    if (!directContentState.footerCaptured) {
      directContentState.footerHidden = directContentState.footer.hidden;
      directContentState.footerCaptured = true;
    }
    suspendNode(directContentState.footer);
  }

  return target;
};

const restoreDirectContent = () => {
  const { main, footer } = directContentState;
  if (!main) return;

  if (directContentState.unavailable && directContentState.mainNodes) {
    main.replaceChildren(...directContentState.mainNodes);
  }

  document.title = directContentState.title || document.title;
  if (directContentState.descriptionNode) {
    directContentState.descriptionNode.setAttribute("content", directContentState.description || "");
  }

  directContentState.unavailable = false;
  revealNode(main);
  if (footer) {
    footer.hidden = directContentState.footerHidden;
    if ("inert" in footer) footer.inert = false;
  }
};

const showUnavailableContent = () => {
  const main = directContentState.main || document.querySelector("main");
  if (!main) return;

  const section = document.createElement("section");
  section.className = "section page-shell content-unavailable";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Greyveil Editions";

  const heading = document.createElement("h1");
  heading.textContent = "This page is unavailable.";

  const copy = document.createElement("p");
  copy.className = "hero-text";
  copy.textContent = "The requested content is not available from this account.";

  const actions = document.createElement("div");
  actions.className = "button-row";
  actions.append(
    createAuthLink("/", "Back to Home", "button primary"),
    createAuthLink(accountPath, "My Account", "button ghost")
  );

  section.append(eyebrow, heading, copy, actions);
  main.replaceChildren(section);
  document.title = "Unavailable | Greyveil Editions";
  if (directContentState.descriptionNode) {
    directContentState.descriptionNode.setAttribute("content", "This Greyveil Editions page is unavailable.");
  }

  directContentState.unavailable = true;
  revealNode(main);
  if (directContentState.footer) {
    directContentState.footer.hidden = true;
    if ("inert" in directContentState.footer) directContentState.footer.inert = true;
  }
};

const restoreLink = (link) => {
  if (link.dataset.originalHref) link.setAttribute("href", link.dataset.originalHref);
  if (link.dataset.originalText) link.textContent = link.dataset.originalText;
  link.removeAttribute("aria-disabled");
};

const lockReaderLink = (link, user) => {
  if (!link.dataset.originalHref) link.dataset.originalHref = link.getAttribute("href") || "";
  if (!link.dataset.originalText) link.dataset.originalText = link.textContent;

  link.href = user ? accountPath : loginPath;
  link.textContent = user ? "Access required" : "Log in to read";
  link.setAttribute("aria-disabled", "true");
};

const purchaseContainerForLink = (link) => link.closest(".button-row, .card-actions") || link.parentElement;

const generatedPurchaseButtons = (container, bookId) => {
  if (!container || !bookId) return [];
  return Array.from(container.querySelectorAll("[data-generated-purchase][data-purchase-book-id]"))
    .filter((button) => button.dataset.purchaseBookId === bookId);
};

const removeGeneratedPurchaseAction = (link, book) => {
  const container = purchaseContainerForLink(link);
  generatedPurchaseButtons(container, book?.id).forEach((button) => button.remove());
};

const ensurePurchaseAction = (link, decision) => {
  const book = decision.book;
  if (!book?.id) return;

  const container = purchaseContainerForLink(link);
  if (!container) return;

  const existing = generatedPurchaseButtons(container, book.id)[0];
  const button = existing || document.createElement("button");
  button.type = "button";
  button.className = container.classList.contains("card-actions")
    ? "button ghost purchase-button"
    : "button primary purchase-button";
  button.dataset.generatedPurchase = "";
  button.dataset.purchaseType = "book";
  button.dataset.purchaseBookId = book.id;
  button.dataset.purchaseLabel = "Buy Book - Rs. 149";
  button.textContent = button.dataset.purchaseLabel;

  if (!existing) {
    link.insertAdjacentElement("afterend", button);
    window.dispatchEvent(new CustomEvent("greyveil:purchases-refresh-labels"));
  }
};

const updateBookSurfaceState = (node, decision, access, context) => {
  if (!node || decision.target.kind !== "book" || !decision.book) return;

  const visibility = access.effectiveVisibilityForBookHierarchy(decision.hierarchy);
  const locked = visibility === "paid" && !decision.canRead;
  const readerLinks = [];

  if (node.matches?.("a[href*='/reader/']")) readerLinks.push(node);
  node.querySelectorAll?.("a[href*='/reader/']").forEach((link) => readerLinks.push(link));

  readerLinks.forEach((link) => {
    if (locked) {
      lockReaderLink(link, context.user);
      ensurePurchaseAction(link, decision);
    } else {
      restoreLink(link);
      removeGeneratedPurchaseAction(link, decision.book);
    }
  });

  if (node.matches?.(".book-card")) {
    const status = node.querySelector("span");
    if (status) {
      if (!status.dataset.originalText) status.dataset.originalText = status.textContent;
      status.textContent = locked ? "Access required" : status.dataset.originalText;
    }
  }
};

const createContentLookup = (hierarchy, access, grants = []) => {
  const currentGrantsByBookId = new Map();
  grants
    .filter((grant) => access.isGrantCurrent(grant))
    .forEach((grant) => {
      if (!currentGrantsByBookId.has(grant.book_id)) {
        currentGrantsByBookId.set(grant.book_id, grant);
      }
    });

  return {
    seriesBySlug: new Map(hierarchy.seriesItems.map((item) => [item.slug, item])),
    booksBySlug: new Map(hierarchy.books.map((item) => [item.slug, item])),
    collectionsBySlug: new Map(hierarchy.collections.map((item) => [item.slug, item])),
    collectionsByTitleSlug: new Map(hierarchy.collections.map((item) => [slugifyContent(item.title), item])),
    currentGrantsByBookId,
  };
};

const contextFromAuthState = (access, authState) => {
  if (!authState) return null;

  return {
    user: authState.user,
    profile: authState.profile,
    role: authState.role || (authState.user ? "customer" : "guest"),
    isAdmin: access.isAdminRole(authState.role),
    displayName: access.displayNameFor(authState.user, authState.profile),
  };
};

const contentDecision = (target, hierarchy, access, context, lookup) => {
  if (target.kind === "collection") {
    const collection = lookup.collectionsBySlug.get(target.slug)
      || lookup.collectionsByTitleSlug.get(target.slug);
    const itemHierarchy = { collection };

    return {
      target,
      allowed: access.canDiscoverContent(itemHierarchy, context),
      collection,
      hierarchy: itemHierarchy,
    };
  }

  if (target.kind === "series") {
    const series = lookup.seriesBySlug.get(target.slug);
    const volume = access.volumeForSeries(series, hierarchy.volumes);
    const itemHierarchy = {
      collection: access.collectionForSeries(series, hierarchy.collections),
      volume,
      series,
    };

    return {
      target,
      allowed: access.canDiscoverContent(itemHierarchy, context),
      series,
      hierarchy: itemHierarchy,
    };
  }

  if (target.kind === "book") {
    const book = lookup.booksBySlug.get(target.slug);
    const itemHierarchy = access.hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes);
    const allowed = access.canDiscoverContent(itemHierarchy, context);
    const currentGrant = book?.id ? lookup.currentGrantsByBookId.get(book.id) : null;
    const canRead = allowed
      ? access.canReadBook({ ...itemHierarchy, grants: currentGrant ? [currentGrant] : [] }, context)
      : false;

    return {
      target,
      allowed,
      canRead,
      book,
      hierarchy: itemHierarchy,
    };
  }

  return { target, allowed: false };
};

const initContentVisibilityFiltering = async (runId = contentVisibilityRun, authState = null) => {
  setAccessPending();
  const directTarget = suspendDirectContent();
  const records = collectContentSurfaceRecords();
  records.forEach(suspendRecord);

  try {
    const access = await import(new URL("content-access.js", mainScriptUrl).href);
    const context = contextFromAuthState(access, authState) || await access.getAccessContext();
    const hierarchy = await access.fetchContentHierarchy();
    const blockingError = hierarchy.errors.collections || hierarchy.errors.volumes || hierarchy.errors.series || hierarchy.errors.books;

    if (runId !== contentVisibilityRun) return;

    if (blockingError) {
      console.info("Content visibility filtering is waiting on Supabase hierarchy schema/RLS.", {
        collections: hierarchy.errors.collections?.message,
        volumes: hierarchy.errors.volumes?.message,
        series: hierarchy.errors.series?.message,
        books: hierarchy.errors.books?.message,
      });
      if (access.isAdminRole(context.role)) {
        records.forEach(attachRecord);
        restoreDirectContent();
      } else {
        records.forEach(detachRecord);
        if (directTarget) showUnavailableContent();
      }
      setAccessResolved(runId);
      return;
    }

    const grantsResult = await access.fetchViewerBookGrants(context.user?.id);
    const grants = grantsResult.data || [];
    const lookup = createContentLookup(hierarchy, access, grants);

    if (runId !== contentVisibilityRun) return;

    records.forEach((record) => {
      const decision = contentDecision(record.target, hierarchy, access, context, lookup);

      if (decision.allowed) {
        attachRecord(record);
        updateBookSurfaceState(record.node, decision, access, context);
      } else {
        detachRecord(record);
      }
    });

    if (directTarget) {
      const decision = contentDecision(directTarget, hierarchy, access, context, lookup);
      if (decision.allowed) {
        restoreDirectContent();
        updateBookSurfaceState(directContentState.main, decision, access, context);
      } else {
        showUnavailableContent();
      }
    }

    setAccessResolved(runId);
  } catch (error) {
    console.info("Content visibility filtering could not run.", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
    records.forEach(detachRecord);
    if (directTarget) showUnavailableContent();
    setAccessResolved(runId);
  }
};

const refreshAuthAndContentVisibility = async () => {
  contentVisibilityRun += 1;
  const runId = contentVisibilityRun;
  setAccessPending();
  const authState = await initAuthNavigation();
  await initContentVisibilityFiltering(runId, authState);
};

const bindAuthStateRefresh = async () => {
  try {
    const { supabase } = await import(new URL("supabase-client.js", mainScriptUrl).href);
    supabase.auth.onAuthStateChange(() => {
      setAccessPending();
      window.clearTimeout(authRefreshTimer);
      authRefreshTimer = window.setTimeout(refreshAuthAndContentVisibility, 0);
    });
  } catch (error) {
    console.info("Auth state listener could not be registered.", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
  }
};

refreshAuthAndContentVisibility();
bindAuthStateRefresh();
window.addEventListener("greyveil:purchase-complete", refreshAuthAndContentVisibility);
import(new URL("purchases.js", mainScriptUrl).href).catch((error) => {
  console.info("Checkout controls could not be initialized.", {
    name: error?.name,
    message: error?.message,
    code: error?.code,
  });
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
