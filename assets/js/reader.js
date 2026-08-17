(function () {
  const DEFAULT_FONT_SIZE = 18;
  const MIN_FONT_SIZE = 17;
  const MAX_FONT_SIZE = 22;
  const PAGINATION_DELAY = 80;
  const SCROLL_SAVE_DELAY = 120;
  const ACCESS_RECHECK_DELAY = 60000;
  const readerScriptUrl = document.currentScript?.src || new URL("/assets/js/reader.js", window.location.href).href;
  const loadFeedbackModule = () => import(new URL("feedback-submission.js", readerScriptUrl).href);
  const loadContentAccessModule = () => import(new URL("content-access.js", readerScriptUrl).href);
  const loadSupabaseModule = () => import(new URL("supabase-client.js", readerScriptUrl).href);
  const currentReaderReturnPath = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const readerLoginUrl = () => `/auth/login/?next=${encodeURIComponent(currentReaderReturnPath())}`;

  // Minimum book.json schema: id, title, readerRoute, themeStylesheet,
  // designSpecFile, feedbackContext, occupationOptions, ratingOptions, and
  // units[] with each unit file containing ordered elements
  // and sourceParagraph anchors.
  const body = document.body;
  let bookUrl = body.dataset.bookUrl || "";
  let readerBookSlug = "";
  let pagesRoot = null;
  let loading = null;
  let brandNode = null;
  let seriesNode = null;
  let titleNode = null;
  let statusNode = null;
  let progressLabel = null;
  let progressBar = null;
  let openContentsButton = null;
  let closeContentsButton = null;
  let drawer = null;
  let drawerBackdrop = null;
  let contentsList = null;
  let fontDecrease = null;
  let fontIncrease = null;
  let themeSelect = null;
  let themeButtons = [];

  const createNode = (tagName, attributes = {}, text = "") => {
    const node = document.createElement(tagName);
    Object.entries(attributes).forEach(([name, value]) => {
      if (value === false || value == null) return;
      node.setAttribute(name, value === true ? "" : value);
    });
    if (text) node.textContent = text;
    return node;
  };

  const clearNode = (node) => {
    if (!node) return;
    while (node.firstChild) node.firstChild.remove();
  };

  const currentReaderSlug = () => {
    const segments = window.location.pathname.split("/").filter(Boolean);
    const booksIndex = segments.indexOf("books");
    const readerIndex = segments.indexOf("reader");
    if (booksIndex < 0 || readerIndex !== booksIndex + 2) return "";

    return decodeURIComponent(segments[booksIndex + 1] || "").replace(/\.html$/, "");
  };

  const setGenericDocumentMeta = () => {
    document.title = "Greyveil Reader | Greyveil Editions";
    const description = document.querySelector("meta[name='description']");
    if (description) {
      description.setAttribute("content", "A protected Greyveil Editions reader.");
    }
  };

  const createReaderShell = () => {
    body.classList.add("reader-book");
    body.dataset.readerShell = "shared";

    const fragment = document.createDocumentFragment();
    const skipLink = createNode("a", { class: "reader-skip-link", href: "#reader-content" }, "Skip to book content");

    const toolbar = createNode("header", { class: "reader-toolbar", "aria-label": "Reader controls" });
    const identity = createNode("div", { class: "reader-toolbar__identity", "aria-label": "Reader status" });
    const brand = createNode("p", { class: "reader-brand", "data-reader-brand": "" }, body.dataset.readerBrand || "Greyveil Reader");
    const series = createNode("p", { class: "reader-series", "data-reader-series": "" }, "Greyveil Editions");
    const titleNode = createNode("p", { class: "reader-title", "data-reader-title": "" }, "Opening reader");
    const status = createNode("p", { class: "reader-status", "data-reader-status": "" }, "Opening reader");
    identity.append(brand, series, titleNode, status);

    const controls = createNode("div", { class: "reader-toolbar__controls", "aria-label": "Reader tools" });
    const exitLink = createNode(
      "a",
      {
        class: "reader-control reader-control--exit",
        href: "/",
        "data-reader-exit": "",
      },
      body.dataset.readerExitLabel || "Exit Reader"
    );
    const contentsButton = createNode(
      "button",
      {
        class: "reader-control",
        type: "button",
        "aria-expanded": "false",
        "aria-controls": "reader-contents",
        "data-open-contents": "",
      },
      "Contents"
    );
    const progress = createNode("div", { class: "reader-progress", "aria-label": "Reading progress" });
    const progressText = createNode("span", { "data-progress-label": "" }, "0%");
    const progressTrack = createNode("span", { class: "reader-progress__track", "aria-hidden": "true" });
    progressTrack.append(createNode("span", { "data-progress-bar": "" }));
    progress.append(progressText, progressTrack);

    const fontControls = createNode("div", { class: "reader-control-group", "aria-label": "Font size" });
    fontControls.append(
      createNode(
        "button",
        {
          class: "reader-control reader-control--icon",
          type: "button",
          "aria-label": "Decrease font size",
          "data-font-decrease": "",
        },
        "A-"
      ),
      createNode(
        "button",
        {
          class: "reader-control reader-control--icon",
          type: "button",
          "aria-label": "Increase font size",
          "data-font-increase": "",
        },
        "A+"
      )
    );
    const themeLabel = createNode("label", { class: "reader-theme-switcher" });
    themeLabel.append(createNode("span", { class: "reader-control-label" }, "Theme"));
    const themeSelectNode = createNode("select", {
      class: "reader-control reader-theme-select",
      "data-theme-select": "",
      "aria-label": "Reader theme",
    });
    ["light", "sepia", "dark"].forEach((themeName) => {
      const option = createNode("option", { value: themeName }, themeName.charAt(0).toUpperCase() + themeName.slice(1));
      themeSelectNode.append(option);
    });
    themeLabel.append(themeSelectNode);

    const typography = createNode("details", { class: "reader-toolbar__more", "data-reader-more": "" });
    typography.append(
      createNode("summary", { class: "reader-control reader-toolbar__more-summary", "aria-label": "Typography controls" }, "Aa"),
      createNode("div", { class: "reader-toolbar__more-panel" })
    );
    typography.querySelector(".reader-toolbar__more-panel").append(fontControls);

    controls.append(contentsButton, progress, themeLabel, typography, exitLink);
    toolbar.append(identity, controls);

    const main = createNode("main", { id: "reader-content", class: "reader-stage", "aria-live": "polite" });
    const loadingNode = createNode("div", { class: "reader-loading", "data-reader-loading": "" });
    loadingNode.append(createNode("p", {}, "Opening reader..."));
    const article = createNode("article", {
      class: "reader-pages",
      "data-reader-pages": "",
      "aria-label": "Reader",
    });
    main.append(loadingNode, article);

    const backdrop = createNode("div", { class: "contents-backdrop", "data-contents-backdrop": "", hidden: "" });
    const contentsDrawer = createNode("aside", {
      class: "contents-drawer",
      id: "reader-contents",
      role: "dialog",
      "aria-modal": "true",
      "aria-hidden": "true",
      "aria-labelledby": "reader-contents-title",
      "data-contents-drawer": "",
      inert: "",
    });
    const drawerHeader = createNode("div", { class: "contents-drawer__header" });
    const drawerTitleGroup = createNode("div");
    drawerTitleGroup.append(
      createNode("p", { class: "contents-drawer__eyebrow", "data-reader-publisher": "" }, body.dataset.readerBrand || "Greyveil Editions"),
      createNode("h2", { id: "reader-contents-title" }, "Contents")
    );
    drawerHeader.append(
      drawerTitleGroup,
      createNode(
        "button",
        {
          class: "reader-control reader-control--icon",
          type: "button",
          "aria-label": "Close contents",
          "data-close-contents": "",
        },
        "Close"
      )
    );
    contentsDrawer.append(
      drawerHeader,
      createNode("nav", { class: "contents-list", "aria-label": "Book contents", "data-contents-list": "" })
    );

    fragment.append(skipLink, toolbar, main, backdrop, contentsDrawer);
    body.prepend(fragment);
  };

  const bindReaderNodes = () => {
    bookUrl = body.dataset.bookUrl || "";
    pagesRoot = document.querySelector("[data-reader-pages]");
    loading = document.querySelector("[data-reader-loading]");
    brandNode = document.querySelector("[data-reader-brand]");
    seriesNode = document.querySelector("[data-reader-series]");
    titleNode = document.querySelector("[data-reader-title]");
    statusNode = document.querySelector("[data-reader-status]");
    progressLabel = document.querySelector("[data-progress-label]");
    progressBar = document.querySelector("[data-progress-bar]");
    openContentsButton = document.querySelector("[data-open-contents]");
    closeContentsButton = document.querySelector("[data-close-contents]");
    drawer = document.querySelector("[data-contents-drawer]");
    drawerBackdrop = document.querySelector("[data-contents-backdrop]");
    contentsList = document.querySelector("[data-contents-list]");
    fontDecrease = document.querySelector("[data-font-decrease]");
    fontIncrease = document.querySelector("[data-font-increase]");
    themeSelect = document.querySelector("[data-theme-select]");
    themeButtons = Array.from(document.querySelectorAll("[data-theme-choice]"));
  };

  setGenericDocumentMeta();

  if (!document.querySelector("[data-reader-pages]")) {
    createReaderShell();
  }

  bindReaderNodes();
  readerBookSlug = currentReaderSlug();

  const requiredNodes = {
    pagesRoot,
    loading,
    brandNode,
    seriesNode,
    titleNode,
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

  if (!themeSelect && themeButtons.length !== 3) missingNodes.push("themeControl");

  if (missingNodes.length) {
    console.error(`Reader markup is missing required controls: ${missingNodes.join(", ")}`);
    return;
  }

  const setReaderControlsEnabled = (enabled) => {
    [openContentsButton, fontDecrease, fontIncrease, themeSelect].forEach((control) => {
      if (control) control.disabled = !enabled;
    });

    themeButtons.forEach((button) => {
      button.disabled = !enabled;
    });
  };

  const resetReaderIdentity = (status = "Opening reader") => {
    setGenericDocumentMeta();
    if (brandNode) brandNode.textContent = body.dataset.readerBrand || "Greyveil Reader";
    if (seriesNode) seriesNode.textContent = "Greyveil Editions";
    if (titleNode) titleNode.textContent = status;
    if (statusNode) statusNode.textContent = status;
    if (progressLabel) progressLabel.textContent = "0%";
    if (progressBar) progressBar.style.width = "0%";
    document.querySelector("[data-reader-publisher]")?.replaceChildren("Greyveil Editions");
    const article = document.querySelector("[data-reader-pages]");
    if (article) article.setAttribute("aria-label", "Reader");
    const exitLink = document.querySelector("[data-reader-exit], .reader-control--exit");
    if (exitLink) {
      exitLink.setAttribute("href", "/");
      exitLink.textContent = body.dataset.readerExitLabel || "Exit Reader";
    }
  };

  setReaderControlsEnabled(false);

  let book = null;
  let units = [];
  let sourceBlocks = [];
  let chapterMarkers = [];
  let savedState = {};
  let scrollSaveTimer = null;
  let resizeTimer = null;
  let paginationToken = 0;
  let readerLoadToken = 0;
  let readerLoaded = false;
  let lastAccessCheck = 0;
  let accessRecheckInFlight = false;
  let activeAccessDecision = null;
  let watermarkSessionSeed = Math.floor(Math.random() * 1000000);
  let restoring = false;
  let appliedBookVariables = [];
  let coverFailed = false;

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const updateReaderShellFromBook = () => {
    const publisher = book.publisher || "Greyveil Editions";
    const title = book.title || "Book";
    const series = book.seriesDisplay || book.series || book.collection || publisher;
    const article = document.querySelector("[data-reader-pages]");
    const publisherNode = document.querySelector("[data-reader-publisher]");
    const exitLink = document.querySelector("[data-reader-exit], .reader-control--exit");
    const description = document.querySelector("meta[name='description']");

    if (article) article.setAttribute("aria-label", title);
    if (brandNode) brandNode.textContent = body.dataset.readerBrand || publisher;
    if (seriesNode) seriesNode.textContent = series;
    if (titleNode) titleNode.textContent = title;
    if (publisherNode) publisherNode.textContent = publisher;
    if (exitLink) {
      const configuredExit = body.dataset.readerExitUrl || book.readerExitUrl || book.detailPageUrl;
      if (configuredExit) exitLink.setAttribute("href", configuredExit);
      exitLink.textContent = body.dataset.readerExitLabel || "Exit Reader";
    }

    if (!body.dataset.readerPreserveTitle) {
      document.title = `${title} Reader | ${publisher}`;
    }

    if (description && !body.dataset.readerPreserveDescription) {
      const author = book.author ? ` by ${book.author}` : "";
      description.setAttribute("content", `A continuous paginated ${publisher} reader for ${title}${author}.`);
    }
  };

  const watermarkTextForDecision = (decision = activeAccessDecision) => {
    const title = book?.title || decision?.book?.title || "Greyveil Reader";
    const authenticatedName = decision?.context?.user
      ? String(
          decision.context.profile?.display_name
          || decision.context.user?.user_metadata?.display_name
          || "Greyveil Reader"
        ).trim()
      : "";
    return `${authenticatedName || "Greyveil Editions"} \u2022 ${title}`;
  };

  const watermarkOffsetForPage = (pageNumber) => {
    const value = (watermarkSessionSeed + Number(pageNumber || 0) * 37) % 41;
    return `${value - 20}px`;
  };

  const applyReaderWatermarks = (decision = activeAccessDecision) => {
    activeAccessDecision = decision?.allowed ? decision : null;
    const watermarkText = activeAccessDecision ? watermarkTextForDecision(activeAccessDecision) : "";
    body.dataset.readerProtected = watermarkText ? "true" : "false";

    pagesRoot?.querySelectorAll(".book-page").forEach((page, index) => {
      let layer = page.querySelector(":scope > .reader-watermark-layer");
      if (!watermarkText) {
        layer?.remove();
        return;
      }
      if (!layer) {
        layer = createNode("div", { class: "reader-watermark-layer", "aria-hidden": "true" });
        page.prepend(layer);
      }
      layer.style.setProperty("--reader-watermark-offset", watermarkOffsetForPage(index + 1));
      layer.replaceChildren(...Array.from({ length: 9 }, () => createNode("span", {}, watermarkText)));
    });
  };

  const protectedReaderTarget = (target) => target instanceof Element
    && Boolean(target.closest(".book-page__content"))
    && !Boolean(target.closest("input, textarea, select, button, [contenteditable='true'], .feedback-panel"));

  const protectedReaderSelection = () => {
    const anchor = window.getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    return protectedReaderTarget(element);
  };

  const blockProtectedReaderEvent = (event) => {
    if (!readerLoaded || (!protectedReaderTarget(event.target) && !protectedReaderSelection())) return;
    event.preventDefault();
  };

  const discourageReaderPrint = (event) => {
    const printShortcut = (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "p";
    if (!readerLoaded || !printShortcut) return;
    event.preventDefault();
    if (statusNode) statusNode.textContent = "Printing is unavailable in Greyveil Reader";
  };

  const loadStylesheet = (href, label) => new Promise((resolve) => {
    if (!href) {
      resolve();
      return;
    }

    const absoluteHref = new URL(href, window.location.href).href;
    const existing = Array.from(document.querySelectorAll("link[rel~='stylesheet']"))
      .find((link) => link.href === absoluteHref);

    if (existing) {
      resolve();
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = absoluteHref;
    link.dataset.readerBookStylesheet = label || "book-theme";
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => {
      console.warn(`Reader stylesheet could not be loaded: ${absoluteHref}`);
      resolve();
    }, { once: true });
    document.head.append(link);
  });

  const loadBookStylesheet = async (bookResponseUrl) => {
    const stylesheet = book.themeStylesheet || book.themeStylesheetFile || book.theme?.stylesheet;
    if (!stylesheet) return;

    const bookRootUrl = new URL(".", bookResponseUrl.href);
    await loadStylesheet(new URL(stylesheet, bookRootUrl).href, book.id);
  };

  const normalizeBookCover = (bookRootUrl) => {
    const cover = book.cover || {};
    if (!cover || typeof cover.web !== "string" || !cover.web.trim()) {
      book.cover = null;
      return;
    }

    try {
      book.cover = {
        ...cover,
        webUrl: new URL(cover.web, bookRootUrl).href,
      };
    } catch (error) {
      book.cover = null;
    }
  };

  const hasCover = () => Boolean(!coverFailed && book?.cover?.webUrl);

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

  const setElementRole = (node, element) => {
    if (element.role) node.dataset.elementRole = element.role;
  };

  const headerSource = (unit, key, fallbackIndex) => {
    if (unit.headerSourceParagraphs && unit.headerSourceParagraphs[key] != null) {
      return unit.headerSourceParagraphs[key];
    }
    if (unit.anchorHeadings && Array.isArray(unit.sourceHeadingParagraphs)) {
      return unit.sourceHeadingParagraphs[fallbackIndex];
    }
    return null;
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
    setSourceParagraph(phase, headerSource(unit, "phase", null));
    header.append(phase);

    const number = unit.suppressHeaderNumber ? "" : unit.number || unit.label || "";
    if (number) {
      const numberNode = document.createElement("p");
      numberNode.className = "unit-header__number";
      numberNode.textContent = number;
      setSourceParagraph(numberNode, headerSource(unit, "number", 0));
      header.append(numberNode);
    }

    const heading = document.createElement("h1");
    heading.textContent = unit.title;
    setSourceParagraph(heading, headerSource(unit, "title", number ? 1 : 0));
    header.append(heading);

    if (unit.subtitle) {
      const subtitle = document.createElement("p");
      subtitle.className = "unit-header__subtitle";
      subtitle.textContent = unit.subtitle;
      setSourceParagraph(subtitle, headerSource(unit, "subtitle", number ? 2 : 1));
      header.append(subtitle);
    }

    return header;
  };

  const createElementNode = (element, unit) => {
    if (element.type === "section-break") {
      const divider = document.createElement("div");
      divider.className = "reader-section-break";
      divider.setAttribute("aria-hidden", "true");
      setElementRole(divider, element);
      return divider;
    }

    if (element.type === "space") {
      const space = document.createElement("div");
      space.className = "reader-space";
      space.setAttribute("aria-hidden", "true");
      setElementRole(space, element);
      return space;
    }

    if (element.type === "blockquote") {
      const quote = document.createElement("blockquote");
      quote.className = "reader-quote";
      if (element.sourceParagraph) quote.dataset.sourceParagraph = String(element.sourceParagraph);
      setElementRole(quote, element);
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
      setElementRole(line, element);
      line.textContent = element.text || "";
      return line;
    }

    const paragraph = document.createElement("p");
    paragraph.className = "reader-paragraph";
    if (element.sourceParagraph) paragraph.dataset.sourceParagraph = String(element.sourceParagraph);
    setElementRole(paragraph, element);
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

    if (unit.openingMode === "source") {
      const copy = document.createElement("div");
      copy.className = "flow-opening__copy flow-opening__copy--source";
      unit.elements.forEach((element) => {
        copy.append(createElementNode(element, unit));
      });
      block.append(copy);
      return block;
    }

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

  const createCoverBlock = () => {
    const block = createBlock("reader-cover-page", {
      unitId: "front-cover",
      unitTitle: book.title || "Cover",
      unitLabel: "Cover",
      unitKind: "cover",
      pageLock: true,
      noPageNumber: true,
      unitStart: true,
    });
    block.dataset.coverPage = "true";

    const frame = document.createElement("div");
    frame.className = "reader-cover-page__frame";

    const image = document.createElement("img");
    image.className = "reader-cover-page__image";
    image.src = book.cover.webUrl;
    image.alt = book.cover.alt || `Cover of ${book.title || "this book"}`;
    image.decoding = "async";
    image.loading = "eager";
    image.dataset.coverImage = "";

    frame.append(image);
    block.append(frame);
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
    if (hasCover()) sourceBlocks.push(createCoverBlock());
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
      applyReaderWatermarks();
      indexMarkers();
      bindCoverFallback();
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
    recheckReaderAccess();
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(saveProgressNow, SCROLL_SAVE_DELAY);
  };

  const applyTheme = (theme) => {
    const safeTheme = ["light", "sepia", "dark"].includes(theme) ? theme : "light";
    document.documentElement.dataset.readerTheme = safeTheme;
    applyBookTheme(safeTheme);
    if (themeSelect) themeSelect.value = safeTheme;
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
    const jumpTargets = units.filter((unit) => ["part", "chapter", "prologue", "introduction", "ending", "epilogue", "teaser"].includes(unit.kind));
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
    const feedbackPage = panel.closest(".book-page");
    const firstControl = panel.querySelector('input:not([type="hidden"]), textarea, select, button');
    feedbackPage?.classList.add("book-page--feedback");
    const setFeedbackStatus = (node, message = "", state = "") => {
      if (!node) return;
      node.dataset.state = state;
      node.textContent = message;
    };
    const setSubmitState = (button, busy) => {
      if (!button) return;
      if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
      button.disabled = busy;
      button.textContent = busy ? "Sending feedback..." : button.dataset.defaultLabel;
    };
    const logFeedbackError = (error) => {
      console.error("Reader feedback submission failed", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
        status: error?.status,
      });
    };

    toggle.addEventListener("click", () => {
      const expanded = panel.hidden;
      panel.hidden = !expanded;
      feedbackPage?.classList.toggle("is-feedback-expanded", expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      if (!expanded) return;

      if (window.matchMedia("(max-width: 640px)").matches) {
        window.requestAnimationFrame(() => {
          const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
          panel.scrollIntoView({ behavior, block: "start" });
        });
      } else {
        firstControl?.focus({ preventScroll: true });
      }
    });

    close?.addEventListener("click", () => {
      panel.hidden = true;
      feedbackPage?.classList.remove("is-feedback-expanded");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus({ preventScroll: true });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector("button[type='submit']");
      const status = form.querySelector("[data-feedback-status]");
      if (form.dataset.submitting === "true") return;

      if (!form.checkValidity()) {
        setFeedbackStatus(status, "Please complete the required fields.", "error");
        form.reportValidity();
        return;
      }

      form.dataset.submitting = "true";
      setSubmitState(submitButton, true);
      setFeedbackStatus(status, "Sending feedback...", "loading");

      try {
        const { clearFeedbackEntryFields, submitFeedback } = await loadFeedbackModule();
        await submitFeedback(form);
        setFeedbackStatus(status, "Thank you. Your feedback has been sent.", "success");
        clearFeedbackEntryFields(form);
      } catch (error) {
        logFeedbackError(error);
        setFeedbackStatus(status, "We could not save your feedback right now. Please try again.", "error");
      } finally {
        delete form.dataset.submitting;
        setSubmitState(submitButton, false);
      }
    });
  };

  const handleCoverImageError = () => {
    if (coverFailed) return;
    coverFailed = true;
    buildSourceBlocks();
    paginate({ restore: { hash: "", scrollRatio: 0 } });
  };

  const bindCoverFallback = () => {
    pagesRoot.querySelectorAll("[data-cover-image]").forEach((image) => {
      if (image.dataset.coverFallbackBound) return;
      image.dataset.coverFallbackBound = "true";
      image.addEventListener("error", handleCoverImageError, { once: true });
      if (image.complete && image.naturalWidth === 0) handleCoverImageError();
    });
  };

  const readerContentErrorPayload = async (error, data) => {
    if (data?.error) return data.error;
    const response = error?.context;
    if (!response || typeof response.clone !== "function") return null;

    try {
      return (await response.clone().json())?.error || null;
    } catch (_error) {
      return null;
    }
  };

  const fetchReaderContent = async (resources) => {
    const { supabase } = await loadSupabaseModule();
    const { data, error } = await supabase.functions.invoke("reader-content", {
      body: {
        book_slug: readerBookSlug,
        resources,
      },
    });

    if (error || !data?.success || !data?.resources) {
      const problem = await readerContentErrorPayload(error, data);
      const reason = ["login_required", "access_required", "unavailable"].includes(problem?.code)
        ? problem.code
        : "unavailable";
      throw readerAccessError({ reason });
    }

    const missing = resources.find((resource) => !Object.prototype.hasOwnProperty.call(data.resources, resource));
    if (missing) throw new Error("Reader content response is incomplete.");
    return data.resources;
  };

  const readerAccessCopy = (reason) => {
    if (reason === "login_required") {
      return {
        title: "Log in to continue.",
        message: "Please log in with an account that has access to this reader.",
        actions: [
          { href: readerLoginUrl(), label: "Log in" },
          { href: "/account/", label: "My Account" },
        ],
      };
    }

    if (reason === "access_required") {
      return {
        title: "Access required.",
        message: "This reader is not available from this account.",
        actions: [
          { href: "/account/", label: "My Account" },
          { href: "/", label: "Back to Website" },
        ],
      };
    }

    return {
      title: "Reader unavailable.",
      message: "This reader is unavailable.",
      actions: [
        { href: "/", label: "Back to Website" },
        { href: "/account/", label: "My Account" },
      ],
    };
  };

  const readerAccessError = (decision) => {
    const copy = readerAccessCopy(decision?.reason);
    const error = new Error(copy.message);
    error.name = "ReaderAccessError";
    error.reason = decision?.reason || "unavailable";
    error.copy = copy;
    error.decision = decision;
    return error;
  };

  const logAccessDecision = (decision, label = "Reader access check did not allow rendering.") => {
    if (decision?.allowed) return;
    console.info(label, {
      reason: decision?.reason,
      role: decision?.context?.role,
      visibility: decision?.visibility,
      errors: decision?.errors?.map(([table, error]) => ({
        table,
        message: error?.message,
        code: error?.code,
      })),
    });
  };

  const resolveCurrentReaderAccess = async () => {
    const access = await loadContentAccessModule();
    let decision = await access.resolveReaderAccess(readerBookSlug);
    if (decision.allowed && decision.reason === "public") {
      const context = await access.getAccessContext();
      decision = { ...decision, context };
    }
    lastAccessCheck = Date.now();
    if (!decision.allowed) logAccessDecision(decision);
    return decision;
  };

  const guardReaderAccess = async () => {
    const decision = await resolveCurrentReaderAccess();
    if (!decision.allowed) throw readerAccessError(decision);
    return decision;
  };

  const readerAccessMarkup = (copy) => `
    <section class="reader-access-message" aria-live="polite">
      <p class="reader-error">${copy.title}</p>
      <p>${copy.message}</p>
      <p>${copy.actions.map((action) => `<a class="reader-control" href="${action.href}">${action.label}</a>`).join(" ")}</p>
    </section>
  `;

  const removeBookStyles = () => {
    document.querySelectorAll("link[data-reader-book-stylesheet]").forEach((link) => link.remove());
    appliedBookVariables.forEach((name) => document.documentElement.style.removeProperty(name));
    appliedBookVariables = [];
  };

  const clearProtectedReaderView = (decision) => {
    readerLoadToken += 1;
    paginationToken += 1;
    window.clearTimeout(scrollSaveTimer);
    window.clearTimeout(resizeTimer);
    closeContents(false);
    removeBookStyles();
    body.classList.remove("is-paginating");
    setReaderControlsEnabled(false);
    resetReaderIdentity(decision?.reason === "login_required" ? "Login required" : "Access unavailable");

    units = [];
    sourceBlocks = [];
    chapterMarkers = [];
    savedState = {};
    coverFailed = false;
    readerLoaded = false;
    activeAccessDecision = null;
    body.dataset.readerProtected = "false";
    book = null;

    if (loading) loading.hidden = true;
    if (contentsList) clearNode(contentsList);
    if (pagesRoot) {
      pagesRoot.removeAttribute("aria-busy");
      pagesRoot.innerHTML = readerAccessMarkup(readerAccessCopy(decision?.reason));
    }
  };

  const recheckReaderAccess = async ({ force = false } = {}) => {
    if (!readerLoaded || accessRecheckInFlight) return;
    if (!force && Date.now() - lastAccessCheck < ACCESS_RECHECK_DELAY) return;

    accessRecheckInFlight = true;
    try {
      const decision = await resolveCurrentReaderAccess();
      if (!decision.allowed) {
        clearProtectedReaderView(decision);
      } else {
        applyReaderWatermarks(decision);
      }
    } catch (error) {
      console.info("Reader access re-check failed.", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
      });
      clearProtectedReaderView({ reason: "unavailable" });
    } finally {
      accessRecheckInFlight = false;
    }
  };

  const handleReaderAuthChange = (event) => {
    if (event === "INITIAL_SESSION") return;

    watermarkSessionSeed = Math.floor(Math.random() * 1000000);
    readerLoadToken += 1;
    clearProtectedReaderView({ reason: "unavailable" });
    clearNode(pagesRoot);
    body.classList.add("is-paginating");
    if (loading) loading.hidden = false;
    resetReaderIdentity("Opening reader");
    setReaderControlsEnabled(false);

    window.setTimeout(() => {
      init();
    }, 0);
  };

  const bindReaderAccessRefresh = async () => {
    try {
      const { supabase } = await loadSupabaseModule();
      supabase.auth.onAuthStateChange(handleReaderAuthChange);
    } catch (error) {
      console.info("Reader auth refresh listener could not be registered.", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) recheckReaderAccess({ force: true });
    });
    window.addEventListener("focus", () => recheckReaderAccess());
    window.setInterval(() => recheckReaderAccess(), ACCESS_RECHECK_DELAY);
  };

  const loadBook = async () => {
    if (!readerBookSlug) {
      throw readerAccessError({ reason: "unavailable" });
    }

    const decision = await guardReaderAccess();
    activeAccessDecision = decision;
    bookUrl = `/assets/books/${decision.book.slug}/book.json`;
    const bookResponseUrl = new URL(bookUrl, window.location.href);
    const manifestResources = await fetchReaderContent(["book.json"]);
    book = manifestResources["book.json"];
    if (!book.id || !book.title || !Array.isArray(book.units)) {
      throw new Error("Book configuration is missing required metadata.");
    }
    book.readerExitUrl = book.readerExitUrl || book.detailPageUrl || `/projects/${decision.bookHierarchy.series.slug}/books/${decision.book.slug}.html`;
    updateReaderShellFromBook();
    await loadBookStylesheet(bookResponseUrl);
    book.storageKey = book.storageKey || `greyveil:${book.id}:continuous-reader:v2`;
    book.feedbackContext = { ...(book.feedbackContext || {}), feedbackType: book.feedbackContext?.feedbackType || "book" };
    savedState = readState();
    const rootUrl = new URL(".", bookResponseUrl.href);
    normalizeBookCover(rootUrl);
    const unitResources = book.units.map((unit) => String(unit.file || "").trim());
    await guardReaderAccess();
    const protectedUnits = await fetchReaderContent(unitResources);
    units = unitResources.map((resource) => protectedUnits[resource]);
    activeAccessDecision = await guardReaderAccess();
    buildSourceBlocks();
  };

  const init = async () => {
    const token = ++readerLoadToken;
    try {
      readerLoaded = false;
      setReaderControlsEnabled(false);
      resetReaderIdentity("Opening reader");
      if (loading) loading.hidden = false;
      clearNode(pagesRoot);
      clearNode(contentsList);
      body.classList.add("is-paginating");
      await loadBook();
      if (token !== readerLoadToken) return;
      applyTheme(savedState.theme || "light");
      const initialFont = savedState.fontSize || DEFAULT_FONT_SIZE;
      document.documentElement.style.setProperty("--reader-body-size", `${clamp(initialFont, MIN_FONT_SIZE, MAX_FONT_SIZE)}px`);
      readerLoaded = true;
      setReaderControlsEnabled(true);
      fontDecrease.disabled = initialFont <= MIN_FONT_SIZE;
      fontIncrease.disabled = initialFont >= MAX_FONT_SIZE;
      const hash = window.location.hash.replace("#", "");
      paginate({ restore: { hash, scrollRatio: hash ? 0 : Number(savedState.scrollRatio || 0) } });
    } catch (error) {
      if (token !== readerLoadToken) return;
      body.classList.remove("is-paginating");
      if (error?.name === "ReaderAccessError") {
        clearProtectedReaderView(error.decision || { reason: error.reason });
        return;
      }
      if (loading) loading.hidden = true;
      setReaderControlsEnabled(false);
      pagesRoot.innerHTML = error?.name === "ReaderAccessError"
        ? readerAccessMarkup(error.copy || readerAccessCopy(error.reason))
        : '<p class="reader-error">The reader could not be opened. Please refresh the page.</p>';
    }
  };

  openContentsButton.addEventListener("click", openContents);
  closeContentsButton.addEventListener("click", () => closeContents());
  drawerBackdrop.addEventListener("click", () => closeContents());
  fontDecrease.addEventListener("click", () => applyFontSize((savedState.fontSize || DEFAULT_FONT_SIZE) - 1));
  fontIncrease.addEventListener("click", () => applyFontSize((savedState.fontSize || DEFAULT_FONT_SIZE) + 1));
  if (themeSelect) {
    themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
  }
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
  document.addEventListener("copy", blockProtectedReaderEvent, true);
  document.addEventListener("cut", blockProtectedReaderEvent, true);
  document.addEventListener("dragstart", blockProtectedReaderEvent, true);
  document.addEventListener("contextmenu", blockProtectedReaderEvent, true);
  document.addEventListener("keydown", discourageReaderPrint, true);

  init();
  bindReaderAccessRefresh();
})();
