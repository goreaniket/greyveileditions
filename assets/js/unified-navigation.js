(() => {
  const legacyHeader = document.querySelector(
    "header[data-header], header.gv-header, header.founder-page-header"
  );

  if (!legacyHeader || legacyHeader.classList.contains("gv-unified-header")) return;

  const stylesheetHref = "/assets/css/unified-navigation.css";
  if (!document.querySelector('link[data-gv-unified-navigation-css]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = stylesheetHref;
    stylesheet.dataset.gvUnifiedNavigationCss = "true";
    document.head.append(stylesheet);
  }

  const header = document.createElement("header");
  header.className = "gv-unified-header";
  header.dataset.header = "";

  header.innerHTML = `
    <a class="gv-unified-wordmark" href="/" aria-label="Greyveil Editions home">
      <span class="gv-unified-mark" aria-hidden="true">G<span>E</span></span>
      <span class="gv-unified-name">GREYVEIL<small>EDITIONS</small></span>
    </a>

    <button
      class="gv-unified-toggle"
      type="button"
      aria-label="Open navigation"
      aria-expanded="false"
      aria-controls="gv-primary-navigation"
    >MENU</button>

    <nav id="gv-primary-navigation" class="gv-unified-nav" aria-label="Primary navigation">
      <a href="/#explore">Discover</a>
      <a href="/#mind">The Mind</a>
      <a href="/#human">The Human</a>
      <a href="/#connection">The Connection</a>
      <a href="/#library">The Library</a>
      <a href="/#collective">The Collective</a>
      <a href="/connect/">Connect</a>
      <a href="/contribute/">Contribute</a>
      <a href="/#origin">The Origin</a>
      <a class="nav-account" href="/auth/login/?next=%2Faccount%2F" aria-label="Sign in or open My Space">Sign in / My Space <span aria-hidden="true">↘</span></a>
    </nav>
  `;

  legacyHeader.replaceWith(header);

  const toggle = header.querySelector(".gv-unified-toggle");
  const nav = header.querySelector(".gv-unified-nav");
  const setOpen = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.textContent = open ? "CLOSE" : "MENU";
  };

  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });

  import("/assets/js/site-account-nav.js").catch((error) => {
    console.info("Greyveil account navigation could not be initialized.", {
      name: error?.name,
      message: error?.message,
    });
  });
})();
