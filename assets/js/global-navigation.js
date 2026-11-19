(() => {
  const logoPath = "/assets/images/greyveil-official-wordmark.svg?v=20261119b";

  const ensureStyles = () => {
    const existing = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .find((link) => link.href.includes("/assets/css/global-navigation.css"));
    if (existing) {
      if (!existing.href.includes("v=20261119b")) existing.href = "/assets/css/global-navigation.css?v=20261119b";
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/css/global-navigation.css?v=20261119b";
    document.head.append(link);
  };

  const applyOfficialWordmark = () => {
    document.querySelectorAll(".gv-global-brand, .wordmark, .gv-brand").forEach((brand) => {
      const existing = brand.querySelector(".gv-global-logo");
      if (existing && existing.getAttribute("src") === logoPath) return;
      const logo = document.createElement("img");
      logo.className = "gv-global-logo";
      logo.src = logoPath;
      logo.alt = "Greyveil Editions";
      logo.width = 156;
      logo.height = 42;
      brand.replaceChildren(logo);
    });
  };

  const createSharedHeader = () => {
    if (document.querySelector(".gv-global-header")) return;
    const legacyHeader = document.querySelector(
      "header[data-header], header.gv-header, header.founder-page-header"
    );
    if (!legacyHeader) return;

    const header = document.createElement("header");
    header.className = "gv-global-header";
    header.innerHTML = `
      <a class="gv-global-brand" href="/" aria-label="Greyveil Editions, home">
        <img class="gv-global-logo" src="${logoPath}" alt="Greyveil Editions" width="156" height="42">
      </a>
      <button class="gv-global-toggle" type="button" aria-expanded="false"
        aria-controls="gv-primary-navigation" aria-label="Open navigation">Menu</button>
      <nav class="gv-global-nav" id="gv-primary-navigation" aria-label="Primary navigation">
        <a href="/#explore">Discover</a><a href="/#mind">The Mind</a>
        <a href="/#human">The Human</a><a href="/#connection">The Connection</a>
        <a href="/#library">The Library</a><a href="/#collective">The Collective</a>
        <a href="/connect/">Connect</a><a href="/contribute/">Contribute</a>
        <a href="/#origin">The Origin</a>
        <a class="gv-global-account nav-account" href="/auth/login/?next=%2Faccount%2F"
          aria-label="Sign in or open My Space">Sign in / My Space <span aria-hidden="true">↘</span></a>
      </nav>`;
    legacyHeader.replaceWith(header);
  };

  ensureStyles();
  createSharedHeader();
  applyOfficialWordmark();
  const pageRoutes = new Map([
    ["Discover", "/connect/discover/"], ["The Mind", "/projects/human-mind/"],
    ["The Human", "/projects/human-experience/"], ["The Connection", "/connect/"],
    ["The Library", "/projects/"], ["The Collective", "/community/"],
    ["Connect", "/connect/"], ["Contribute", "/contribute/"], ["The Origin", "/founder/"],
  ]);
  document.querySelectorAll(".gv-global-header .gv-global-nav a, .site-header .primary-nav a").forEach((link) => {
    const label = link.textContent.trim().replace(/[↘↗→]/g, "").trim();
    if (pageRoutes.has(label)) link.setAttribute("href", pageRoutes.get(label));
  });
  document.querySelectorAll(".site-header").forEach((header) => {
    const toggle = header.querySelector(".menu-toggle");
    const nav = header.querySelector(".primary-nav");
    if (!toggle || !nav || toggle.dataset.gvBound === "true") return;
    toggle.dataset.gvBound = "true";
    const setOpen = (open) => {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      toggle.textContent = open ? "Close" : "Menu";
    };
    toggle.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
    nav.addEventListener("click", (event) => { if (event.target.closest("a")) setOpen(false); });
    document.addEventListener("pointerdown", (event) => { if (nav.classList.contains("open") && !header.contains(event.target)) setOpen(false); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && nav.classList.contains("open")) { setOpen(false); toggle.focus(); } });
    window.addEventListener("popstate", () => setOpen(false));
    window.addEventListener("hashchange", () => setOpen(false));
    window.addEventListener("pageshow", () => setOpen(false));
  });
  document.querySelectorAll(".gv-global-header").forEach((header) => {
    const toggle = header.querySelector(".gv-global-toggle");
    const nav = header.querySelector(".gv-global-nav");
    if (!toggle || !nav || toggle.dataset.bound === "true") return;
    toggle.dataset.bound = "true";
    const setOpen = (open) => {
      header.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      toggle.textContent = open ? "Close" : "Menu";
    };
    toggle.addEventListener("click", () => setOpen(!header.classList.contains("is-open")));
    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("pointerdown", (event) => { if (header.classList.contains("is-open") && !header.contains(event.target)) setOpen(false); });
    window.addEventListener("popstate", () => setOpen(false));
    window.addEventListener("hashchange", () => setOpen(false));
    window.addEventListener("pageshow", () => setOpen(false));
    window.addEventListener("resize", () => {
      if (window.innerWidth > 1120) setOpen(false);
    }, { passive: true });
  });

  const applyCoverMarks = () => {
    const selector = ".book-cover-image, .library-card__cover img, .book-card img, .project-card img[src*='cover'], img[src*='/assets/books/'][src*='cover'], img[src*='/covers/']";
    document.querySelectorAll(selector).forEach((image) => {
      const parent = image.parentElement;
      if (!parent || parent.querySelector(":scope > .gv-cover-publisher-mark")) return;
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      const mark = document.createElement("span");
      mark.className = "gv-cover-publisher-mark";
      mark.setAttribute("aria-label", "Greyveil Editions");
      mark.setAttribute("role", "img");
      parent.append(mark);
    });
  };
  applyCoverMarks();
  new MutationObserver(applyCoverMarks).observe(document.body, { childList: true, subtree: true });
  import("/assets/js/site-account-nav.js").catch((error) => {
    console.info("Greyveil account navigation could not be initialized.", {
      name: error?.name, message: error?.message
    });
  });
})();