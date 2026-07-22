(function () {
  const DEFAULT_FONT_SIZE = 18;
  const MIN_FONT_SIZE = 17;
  const MAX_FONT_SIZE = 22;
  const PAGINATION_DELAY = 80;
  const SCROLL_SAVE_DELAY = 120;

  // Minimum book.json schema: id, title, readerRoute, storageKey,
  // feedbackEndpoint, feedbackContext, occupationOptions, ratingOptions, and
  // units[] with each unit file containing ordered elements and sourceParagraph anchors.
  const body = document.body;
  const bookUrl = body.dataset.bookUrl;
  const pagesRoot = document.querySelector("[data-reader-pages]");
  const loading = document.querySelector("[data-reader-loading]");
  const statusNode = document.querySelector("[data-reader-status]");
  const progressLabel = document.querySelector("[data-progress-label]");
  const progressBar = document.querySelector("[data-progress-bar]");
  const openContentsButton = document.querySelector("[data-open-contents]");
  const closeContentsButton = document.querySelector("[data-close-contents]");
  const drawer = document.querySelector("[data-contents-drawer]");
  const drawerBackdrop = document.querySelector("[data-contents-backdrop]");
  const contentsList = document.querySelector("[data-contents-list]");
  const fontDecrease = document.querySelector("[data-font-decrease]");
  const fontIncrease = document.querySelector("[data-font-increase]");
  const themeButtons = Array.from(document.querySelectorAll("[data-theme-choice]"));

  const requiredNodes = {
    bookUrl,
    pagesRoot,
    loading,
    statusNode,
    progressLabel,
    progressBar,
    openContentsButton,
    closeContentsButton,
    drawer,
    drawerBackdrop,
    contentsList,
    fontDecrease,
    fontIncrease,
  };
  const missingNodes = Object.entries(requiredNodes)
    .filter(([, node]) => !node)
    .map(([name]) => name);

  if (missingNodes.length || themeButtons.length !== 3) {
    console.error(`Reader markup is missing required controls: ${missingNodes.join(", ")}`);
    return;
  }

  let book = null;
  let units = [];
  let sourceBlocks = [];
  let chapterMarkers = [];
  let savedState = {};
  let scrollSaveTimer = null;
  let resizeTimer = null;
  let paginationToken = 0;
  let restoring = false;
  let appliedBookVariables = [];

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const readState = () => {
    if (!book) return {};
    try {
      return JSON.parse(localStorage.getItem(book.storageKey) || "{}");
    } catch (error) {
      return {};
    }
  };

  const writeState = (patch) => {
    if (!book) return;
    savedState = { ...savedState, ...patch };
    try {
      localStorage.setItem(book.storageKey, JSON.stringify(savedState));
    } catch (error) {
      // Storage can be unavailable in private or embedded browser contexts.
    }
  };

  const applyBookTheme = (readerTheme) => {
    const theme = book.theme || {};
    if (theme.className) body.classList.add(theme.className);

    appliedBookVariables.forEach((name) => document.documentElement.style.removeProperty(name));
    appliedBookVariables = [];

    const configuredVariables = theme.variables || {};
    const hasScopedVariables = ["light", "sepia", "dark"].some((name) => configuredVariables[name]);
    const variables = hasScopedVariables
      ? configuredVariables[readerTheme] || {}
      : readerTheme === "light"
        ? configuredVariables
        : {};

    Object.entries(variables).forEach(([name, value]) => {
      if (/^--reader-[a-z0-9-]+$/.test(name) && typeof value === "string") {
        document.documentElement.style.setProperty(name, value);
        appliedBookVariables.push(name);
      }
    });
  };

  const feedbackContext = () => ({
    collection: book.feedbackContext?.collection || book.collection || "",
    series: book.feedbackContext?.series || book.series || "",
    book: book.feedbackContext?.book || book.title || "",
    feedbackType: book.feedbackContext?.feedbackType || "book",
  });

  const createHiddenInput = (name, value) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value || "";
    return input;
  };

  const createLabel = (labelText, control) => {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(span, control);
    return label;
  };

  const createTextInput = (name, type, autocomplete, required = false) => {
    const input = document.createElement("input");
    input.name = name;
    input.type = type;
    if (autocomplete) input.autocomplete = autocomplete;
    input.required = required;
    return input;
  };

  const createSelect = (name, options, placeholder) => {
    const select = document.createElement("select");
    select.name = name;
    select.required = true;
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = placeholder;
    placeholderOption.selected = true;
    placeholderOption.defaultSelected = true;
    placeholderOption.disabled = true;
    placeholderOption.hidden = true;
    select.append(placeholderOption);
    options.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
    return select;
  };

  const appendRuns = (target, runs = []) => {
    runs.forEach((run) => {
      let node = document.createTextNode(run.text || "");
      if (run.italic) {
        const em = document.createElement("em");
        em.append(node);
        node = em;
      }
      if (run.bold) {
        const strong = document.createElement("strong");
        strong.append(node);
        node = strong;
      }
      target.append(node);
    });
  };

  const sourceParagraphIds = (unit) => unit.elements
    .filter((element) => element.sourceParagraph != null)
    .map((element) => String(element.sourceParagraph));

  const setSourceParagraph = (node, sourceId) => {
    if (sourceId) node.dataset.sourceParagraph = sourceId;
  };

  const instantScrollTo = (top) => {
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, top);
    window.requestAnimationFrame(() => {
      root.style.scrollBehavior = previousScrollBehavior;
    });
  };

  const createBlock = (className, options = {}) => {
    const block = document.createElement("div");
    block.className = `flow-block ${className || ""}`.trim();
    if (options.unitId) block.dataset.unitId = options.unitId;
    if (options.unitTitle) block.dataset.unitTitle = options.unitTitle;
    if (options.unitLabel) block.dataset.unitLabel = options.unitLabel;
    if (options.unitKind) block.dataset.unitKind = options.unitKind;
    if (options.pageStart) block.dataset.forcePageStart = "true";
    if (options.pageLock) block.dataset.pageLock = "true";
    if (options.noPageNumber) block.dataset.noPageNumber = "true";
    if (options.unitStart) block.dataset.unitStart = options.unitId || "";
    return block;
  };

  const createHeader = (unit) => {
    const header = document.createElement("header");
    header.className = `unit-header${unit.kind === "chapter" ? " unit-header--chapter" : ""}`;

    const phase = document.createElement("p");
    phase.className = "unit-header__phase";
    phase.textContent = unit.phase || book.series || book.title;
    header.append(phase);

    const number = unit.number || unit.label || "";
    if (number) {
      const numberNode = document.createElement("p");
      numberNode.className = "unit-header__number";
      numberNode.textContent = number;
      header.append(numberNode);
    }

    const heading = document.createElement("h1");
    heading.textContent = unit.title;
    header.append(heading);

    if (unit.subtitle) {
      const subtitle = document.createElement("p");
      subtitle.className = "unit-header__subtitle";
      subtitle.textContent = unit.subtitle;
      header.append(subtitle);
    }

    return header;
  };

  const createElementNode = (element, unit) => {
    if (element.type === "section-break") {
      const divider = document.createElement("div");
      divider.className = "reader-section-break";
      divider.setAttribute("aria-hidden", "true");
      return divider;
    }

    if (element.type === "space") {
      const space = document.createElement("div");
      space.className = "reader-space";
      space.setAttribute("aria-hidden", "true");
      return space;
    }

    if (element.type === "blockquote") {
      const quote = document.createElement("blockquote");
      quote.className = "reader-quote";
      if (element.sourceParagraph) quote.dataset.sourceParagraph = String(element.sourceParagraph);
      appendRuns(quote, element.runs);
      return quote;
    }

    if (element.type && element.type.startsWith("toc-")) {
      const line = document.createElement("p");
      line.className = element.type === "toc-heading"
        ? "source-contents__heading"
        : element.type === "toc-chapter"
          ? "source-contents__chapter"
          : "source-contents__line";
      if (element.sourceParagraph) line.dataset.sourceParagraph = String(element.sourceParagraph);
      line.textContent = element.text || "";
      return line;
    }

    const paragraph = document.createElement("p");
    paragraph.className = "reader-paragraph";
    if (element.sourceParagraph) paragraph.dataset.sourceParagraph = String(element.sourceParagraph);
    appendRuns(paragraph, element.runs);
    return paragraph;
  };

  const createOpeningBlock = (unit) => {
    const block = createBlock("flow-opening", {
      unitId: "opening",
      unitTitle: book.title,
      unitLabel: "Opening",
      unitKind: "opening",
      pageLock: true,
      noPageNumber: true,
      unitStart: true,
    });
    const sourceIds = sourceParagraphIds(unit);

    const copy = document.createElement("div");
    copy.className = "flow-opening__copy";
    const series = document.createElement("p");
    series.className = "flow-opening__series";
    series.textContent = book.seriesDisplay || book.series || book.collection || book.publisher || "";
    setSourceParagraph(series, sourceIds[0]);
    const bookNumber = document.createElement("p");
    bookNumber.className = "flow-opening__book-number";
    bookNumber.textContent = book.bookNumber || "";
    setSourceParagraph(bookNumber, sourceIds[1]);
    const heading = document.createElement("h1");
    heading.textContent = book.title;
    setSourceParagraph(heading, sourceIds[2]);
    const subtitle = document.createElement("p");
    subtitle.className = "flow-opening__subtitle";
    subtitle.textContent = book.subtitle || "";
    setSourceParagraph(subtitle, sourceIds[3]);
    const author = document.createElement("p");
    author.className = "flow-opening__author";
    author.textContent = book.author || "";
    setSourceParagraph(author, sourceIds[4]);
    const publisher = document.createElement("p");
    publisher.className = "flow-opening__publisher";
    publisher.textContent = [book.publisher, book.editionYear].filter(Boolean).join(" ");
    setSourceParagraph(publisher, sourceIds[5]);
    copy.append(series, bookNumber, heading, subtitle, author, publisher);

    const cover = document.createElement("img");
    cover.className = "flow-opening__cover";
    cover.src = book.coverUrl;
    cover.alt = `Cover of ${book.title}`;
    cover.decoding = "async";

    block.append(copy, cover);
    return block;
  };

  const createContentsBlocks = (unit) => {
    const blocks = [];
    const opener = createBlock("source-contents-page", {
      unitId: unit.id,
      unitTitle: unit.title,
      unitLabel: unit.label,
      unitKind: unit.kind,
      pageStart: true,
      noPageNumber: true,
      unitStart: true,
    });
    opener.append(createHeader(unit));
    blocks.push(opener);

    unit.elements.forEach((element) => {
      const block = createBlock("source-contents source-contents-row", {
        unitId: unit.id,
        unitTitle: unit.title,
        unitLabel: unit.label,
        unitKind: unit.kind,
        noPageNumber: true,
      });
      block.append(createElementNode(element, unit));
      blocks.push(block);
    });

    return blocks;
  };

  const createDedicationBlock = (unit) => {
    const block = createBlock("dedication-page", {
      unitId: unit.id,
      unitTitle: unit.title,
      unitLabel: unit.label,
      unitKind: unit.kind,
      pageLock: true,
      noPageNumber: true,
      unitStart: true,
    });
    block.append(createHeader(unit));
    unit.elements.forEach((element) => block.append(createElementNode(element, unit)));
    return block;
  };

  const createUnitBlocks = (unit) => {
    if (unit.kind === "opening") return [createOpeningBlock(unit)];
    if (unit.kind === "contents") return createContentsBlocks(unit);
    if (unit.kind === "dedication") return [createDedicationBlock(unit)];

    const blocks = [];
    const opener = createBlock("unit-opener", {
      unitId: unit.id,
      unitTitle: unit.title,
      unitLabel: unit.label,
      unitKind: unit.kind,
      pageStart: true,
      unitStart: true,
    });
    opener.append(createHeader(unit));
    blocks.push(opener);

    unit.elements.forEach((element) => {
      const block = createBlock("", {
        unitId: unit.id,
        unitTitle: unit.title,
        unitLabel: unit.label,
        unitKind: unit.kind,
      });
      block.append(createElementNode(element, unit));
      blocks.push(block);
    });

    return blocks;
  };

  const createFeedbackBlock = () => {
    const block = createBlock("book-end", {
      unitId: "book-feedback",
      unitTitle: "Book Feedback",
      unitLabel: "Feedback",
      unitKind: "feedback",
      pageLock: true,
      noPageNumber: true,
      unitStart: true,
    });

    const mark = document.createElement("div");
    mark.className = "book-end__mark";
    mark.setAttribute("aria-hidden", "true");
    const heading = document.createElement("h2");
    heading.textContent = `End of ${book.title || "Book"}`;
    const note = document.createElement("p");
    note.textContent = "A quiet place to leave one whole-book response for Greyveil Editions.";
    const toggle = document.createElement("button");
    toggle.className = "reader-control";
    toggle.type = "button";
    toggle.textContent = "Share Your Feedback";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "book-feedback-panel");
    toggle.dataset.feedbackToggle = "";

    const panel = document.createElement("section");
    panel.className = "feedback-panel";
    panel.id = "book-feedback-panel";
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", "book-feedback-title");
    const context = feedbackContext();
    const kicker = document.createElement("p");
    kicker.className = "feedback-kicker";
    kicker.textContent = "Book feedback";
    const panelHeading = document.createElement("h2");
    panelHeading.id = "book-feedback-title";
    panelHeading.textContent = "Share Your Feedback";
    const form = document.createElement("form");
    form.action = book.feedbackEndpoint;
    form.method = "POST";
    form.dataset.bookFeedback = "";
    form.append(
      createHiddenInput("collection", context.collection),
      createHiddenInput("series", context.series),
      createHiddenInput("book", context.book),
      createHiddenInput("feedbackType", context.feedbackType),
      createLabel("Name", createTextInput("name", "text", "name")),
      createLabel("Email", createTextInput("email", "email", "email", true))
    );

    const feedback = document.createElement("textarea");
    feedback.name = "feedback";
    feedback.rows = 5;
    feedback.required = true;
    form.append(
      createLabel("Feedback", feedback),
      createLabel("Occupation", createSelect("occupation", book.occupationOptions || [], "Select occupation")),
      createLabel("Rating", createSelect("rating", book.ratingOptions || [], "Select rating"))
    );

    const actions = document.createElement("div");
    actions.className = "feedback-panel__actions";
    const submit = document.createElement("button");
    submit.className = "reader-control";
    submit.type = "submit";
    submit.textContent = "Send Feedback";
    const closeButton = document.createElement("button");
    closeButton.className = "reader-control";
    closeButton.type = "button";
    closeButton.dataset.feedbackClose = "";
    closeButton.textContent = "Close";
    actions.append(submit, closeButton);

    const status = document.createElement("p");
    status.className = "feedback-panel__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.feedbackStatus = "";
    form.append(actions, status);
    panel.append(kicker, panelHeading, form);

    block.append(mark, heading, note, toggle, panel);
    return block;
  };

  const buildSourceBlocks = () => {
    sourceBlocks = [];
    units.forEach((unit) => {
      sourceBlocks.push(...createUnitBlocks(unit));
    });
    sourceBlocks.push(createFeedbackBlock());
  };

  const createPage = () => {
    const page = document.createElement("section");
    page.className = "book-page";
    page.setAttribute("aria-label", "Book page");
    const content = document.createElement("div");
    content.className = "book-page__content";
    const number = document.createElement("div");
    number.className = "book-page__number";
    page.append(content, number);
    return { page, content, number, blockCount: 0, noNumber: false };
  };

  const finalizePage = (current, fragment, pageNumber) => {
    if (!current || current.blockCount === 0) return pageNumber;
    current.page.dataset.page = String(pageNumber);
    current.page.dataset.noPageNumber = String(current.noNumber);
    current.number.textContent = String(pageNumber);
    fragment.append(current.page);
    return pageNumber + 1;
  };

  const overflows = (content) => content.scrollHeight > content.clientHeight + 1;

  const paginate = (options = {}) => {
    const token = ++paginationToken;
    const restore = options.restore || captureRestorePoint();
    body.classList.add("is-paginating");
    pagesRoot.setAttribute("aria-busy", "true");

    window.requestAnimationFrame(() => {
      if (token !== paginationToken) return;
      const fragment = document.createDocumentFragment();
      pagesRoot.innerHTML = "";
      chapterMarkers = [];
      let current = createPage();
      pagesRoot.append(current.page);
      let pageNumber = 1;

      sourceBlocks.forEach((sourceBlock) => {
        const isLockedPage = sourceBlock.dataset.pageLock === "true";
        const mustStartPage = sourceBlock.dataset.forcePageStart === "true";

        if ((mustStartPage || isLockedPage) && current.blockCount > 0) {
          pageNumber = finalizePage(current, fragment, pageNumber);
          current = createPage();
          pagesRoot.append(current.page);
        }

        const clone = sourceBlock.cloneNode(true);
        current.content.append(clone);
        current.blockCount += 1;
        current.noNumber = current.noNumber || clone.dataset.noPageNumber === "true";

        if (!isLockedPage && overflows(current.content) && current.blockCount > 1) {
          current.content.removeChild(clone);
          current.blockCount -= 1;
          current.noNumber = Array.from(current.content.children).some((child) => child.dataset.noPageNumber === "true");
          pageNumber = finalizePage(current, fragment, pageNumber);
          current = createPage();
          pagesRoot.append(current.page);
          current.content.append(clone);
          current.blockCount = 1;
          current.noNumber = clone.dataset.noPageNumber === "true";
        }

        if (isLockedPage) {
          pageNumber = finalizePage(current, fragment, pageNumber);
          current = createPage();
          pagesRoot.append(current.page);
        }
      });

      pageNumber = finalizePage(current, fragment, pageNumber);
      pagesRoot.innerHTML = "";
      pagesRoot.append(fragment);
      indexMarkers();
      bindFeedback();
      updateProgress();
      restorePosition(restore);
      body.classList.remove("is-paginating");
      pagesRoot.setAttribute("aria-busy", "false");
    });
  };

  const indexMarkers = () => {
    chapterMarkers = Array.from(pagesRoot.querySelectorAll("[data-unit-start]")).map((node) => ({
      id: node.dataset.unitStart,
      title: node.dataset.unitTitle || "",
      label: node.dataset.unitLabel || "",
      kind: node.dataset.unitKind || "",
      node,
    }));
    renderContentsDrawer();
  };

  const captureRestorePoint = () => {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    return {
      hash: window.location.hash.replace("#", ""),
      scrollRatio: clamp(window.scrollY / maxScroll, 0, 1),
      scrollY: window.scrollY,
    };
  };

  const restorePosition = (restore) => {
    restoring = true;
    const hashTarget = restore.hash ? findMarker(restore.hash) : null;
    const applyScroll = () => {
      if (hashTarget) {
        scrollToMarker(hashTarget, false);
        return;
      }
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      instantScrollTo(maxScroll * Number(restore.scrollRatio || 0));
    };
    applyScroll();
    if (hashTarget) {
      window.requestAnimationFrame(() => window.setTimeout(applyScroll, 60));
      window.setTimeout(applyScroll, 240);
    }
    window.setTimeout(() => {
      restoring = false;
      updateProgress();
      saveProgressNow();
    }, hashTarget ? 340 : 80);
  };

  const findMarker = (id) => chapterMarkers.find((marker) => marker.id === id);

  const scrollToMarker = (marker, smooth = true) => {
    const top = marker.node.closest(".book-page").offsetTop - 12;
    if (smooth) {
      window.scrollTo({ top, behavior: "smooth" });
    } else {
      instantScrollTo(top);
    }
    if (marker.id !== "opening") history.replaceState(null, "", `#${marker.id}`);
    closeContents(false);
  };

  const nearestMarker = () => {
    if (!chapterMarkers.length) return null;
    const offset = window.scrollY + 140;
    let active = chapterMarkers[0];
    chapterMarkers.forEach((marker) => {
      const page = marker.node.closest(".book-page");
      if (page && page.offsetTop <= offset) active = marker;
    });
    return active;
  };

  const updateProgress = () => {
    if (!book) return;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const percent = Math.round(clamp(window.scrollY / maxScroll, 0, 1) * 100);
    progressLabel.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    const active = nearestMarker();
    if (active) {
      statusNode.textContent = `${active.label || "Section"} - ${active.title}`;
      contentsList.querySelectorAll("[data-contents-target]").forEach((button) => {
        button.setAttribute("aria-current", String(button.dataset.contentsTarget === active.id));
      });
    }
  };

  const saveProgressNow = () => {
    if (!book || restoring) return;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const active = nearestMarker();
    writeState({
      scrollRatio: clamp(window.scrollY / maxScroll, 0, 1),
      scrollY: window.scrollY,
      chapterId: active ? active.id : "",
    });
  };

  const saveProgressDebounced = () => {
    updateProgress();
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(saveProgressNow, SCROLL_SAVE_DELAY);
  };

  const applyTheme = (theme) => {
    const safeTheme = ["light", "sepia", "dark"].includes(theme) ? theme : "light";
    document.documentElement.dataset.readerTheme = safeTheme;
    applyBookTheme(safeTheme);
    themeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === safeTheme));
    });
    writeState({ theme: safeTheme });
  };

  const applyFontSize = (size) => {
    const nextSize = clamp(Number(size) || DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE);
    document.documentElement.style.setProperty("--reader-body-size", `${nextSize}px`);
    fontDecrease.disabled = nextSize <= MIN_FONT_SIZE;
    fontIncrease.disabled = nextSize >= MAX_FONT_SIZE;
    writeState({ fontSize: nextSize });
    paginate({ restore: captureRestorePoint() });
  };

  const renderContentsDrawer = () => {
    const jumpTargets = units.filter((unit) => ["chapter", "prologue", "introduction", "ending", "epilogue", "teaser"].includes(unit.kind));
    contentsList.innerHTML = "";
    jumpTargets.forEach((unit) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.contentsTarget = unit.id;
      const label = document.createElement("span");
      label.className = "contents-list__label";
      label.textContent = unit.label || unit.number || "Section";
      const title = document.createElement("span");
      title.className = "contents-list__title";
      title.textContent = unit.title;
      button.append(label, title);
      button.addEventListener("click", () => {
        const marker = findMarker(unit.id);
        if (marker) scrollToMarker(marker);
      });
      contentsList.append(button);
    });
    updateProgress();
  };

  const openContents = () => {
    drawer.hidden = false;
    drawer.removeAttribute("inert");
    drawerBackdrop.hidden = false;
    window.requestAnimationFrame(() => {
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
      openContentsButton.setAttribute("aria-expanded", "true");
      closeContentsButton.focus({ preventScroll: true });
    });
  };

  const closeContents = (focusButton = true) => {
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    drawer.setAttribute("inert", "");
    openContentsButton.setAttribute("aria-expanded", "false");
    drawerBackdrop.hidden = true;
    if (focusButton) openContentsButton.focus({ preventScroll: true });
  };

  const closeContentsOnEscape = (event) => {
    if ((event.key === "Escape" || event.key === "Esc") && drawer.classList.contains("is-open")) {
      event.preventDefault();
      closeContents();
    }
  };

  const bindFeedback = () => {
    const toggle = pagesRoot.querySelector("[data-feedback-toggle]");
    const panel = pagesRoot.querySelector("#book-feedback-panel");
    const close = pagesRoot.querySelector("[data-feedback-close]");
    const form = pagesRoot.querySelector("[data-book-feedback]");
    if (!toggle || !panel || !form) return;

    toggle.addEventListener("click", () => {
      const expanded = panel.hidden;
      panel.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      if (expanded) panel.querySelector('input:not([type="hidden"]), textarea, select, button')?.focus({ preventScroll: true });
    });

    close?.addEventListener("click", () => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector("button[type='submit']");
      const status = form.querySelector("[data-feedback-status]");
      const data = new FormData(form);
      const feedback = (data.get("feedback") || "").toString().trim();
      const email = (data.get("email") || "").toString().trim();
      if (!feedback || !email) return;

      const submission = {
        name: (data.get("name") || "").toString().trim(),
        email,
        feedback,
        message: feedback,
        collection: (data.get("collection") || "").toString().trim(),
        series: (data.get("series") || "").toString().trim(),
        book: (data.get("book") || "").toString().trim(),
        occupation: (data.get("occupation") || "").toString().trim(),
        rating: (data.get("rating") || "").toString().trim(),
        feedbackType: (data.get("feedbackType") || "").toString().trim(),
      };
      const payload = new FormData();
      ["name", "email", "feedback", "message", "collection", "series", "book", "occupation", "rating", "feedbackType"].forEach((key) => {
        payload.append(key, submission[key]);
      });

      submitButton.disabled = true;
      status.dataset.state = "loading";
      status.textContent = "Sending feedback...";

      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: payload,
          headers: { Accept: "application/json" },
        });

        if (response.ok) {
          status.dataset.state = "success";
          status.textContent = "Thank you. Your feedback has been sent.";
          form.elements.name.value = "";
          form.elements.email.value = "";
          form.elements.feedback.value = "";
          form.elements.occupation.value = "";
          form.elements.rating.value = "";
        } else {
          status.dataset.state = "error";
          status.textContent = "There was a problem submitting your feedback.";
        }
      } catch (error) {
        status.dataset.state = "error";
        status.textContent = "There was a network problem.";
      }

      submitButton.disabled = false;
    });
  };

  const fetchJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load ${url}`);
    return response.json();
  };

  const loadBook = async () => {
    const bookResponseUrl = new URL(bookUrl, window.location.href);
    book = await fetchJson(bookResponseUrl.href);
    if (!book.id || !book.title || !Array.isArray(book.units)) {
      throw new Error("Book configuration is missing required metadata.");
    }
    book.storageKey = book.storageKey || `greyveil:${book.id}:continuous-reader:v2`;
    book.feedbackContext = { ...(book.feedbackContext || {}), feedbackType: book.feedbackContext?.feedbackType || "book" };
    savedState = readState();
    const rootUrl = new URL(".", bookResponseUrl.href);
    units = await Promise.all(book.units.map((unit) => fetchJson(new URL(unit.file, rootUrl).href)));
    buildSourceBlocks();
  };

  const init = async () => {
    try {
      body.classList.add("is-paginating");
      await loadBook();
      applyTheme(savedState.theme || "light");
      const initialFont = savedState.fontSize || DEFAULT_FONT_SIZE;
      document.documentElement.style.setProperty("--reader-body-size", `${clamp(initialFont, MIN_FONT_SIZE, MAX_FONT_SIZE)}px`);
      fontDecrease.disabled = initialFont <= MIN_FONT_SIZE;
      fontIncrease.disabled = initialFont >= MAX_FONT_SIZE;
      const hash = window.location.hash.replace("#", "");
      paginate({ restore: { hash, scrollRatio: hash ? 0 : Number(savedState.scrollRatio || 0) } });
    } catch (error) {
      body.classList.remove("is-paginating");
      pagesRoot.innerHTML = '<p class="reader-error">The reader could not be opened. Please refresh the page.</p>';
    }
  };

  openContentsButton.addEventListener("click", openContents);
  closeContentsButton.addEventListener("click", () => closeContents());
  drawerBackdrop.addEventListener("click", () => closeContents());
  fontDecrease.addEventListener("click", () => applyFontSize((savedState.fontSize || DEFAULT_FONT_SIZE) - 1));
  fontIncrease.addEventListener("click", () => applyFontSize((savedState.fontSize || DEFAULT_FONT_SIZE) + 1));
  themeButtons.forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
  });
  window.addEventListener("scroll", saveProgressDebounced, { passive: true });
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => paginate({ restore: captureRestorePoint() }), PAGINATION_DELAY);
  });
  window.addEventListener("hashchange", () => {
    const marker = findMarker(window.location.hash.replace("#", ""));
    if (marker) scrollToMarker(marker);
  });
  window.addEventListener("keydown", closeContentsOnEscape);
  drawer.addEventListener("keydown", closeContentsOnEscape);
  document.addEventListener("keydown", closeContentsOnEscape, true);

  init();
})();
