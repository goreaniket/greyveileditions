(() => {
  const logoPath = "/assets/images/greyveil-official-wordmark.png?v=20261111";
  const ensureStyles = () => {
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href.includes("/assets/css/global-navigation.css"))) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/css/global-navigation.css?v=20261111";
    document.head.append(link);
  };
  const applyOfficialWordmark = () => {
    document.querySelectorAll(".gv-global-brand, .wordmark").forEach((brand) => {
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
    const legacyHeader = document.querySelector("header[data-header], header.gv-header, header.founder-page-header");
    if (!legacyHeader) return;
    const header = document.createElement("header");
    header.className = "gv-global-header";
    header.innerHTML = `<a class="gv-global-brand" href="/" aria-label="Greyveil Editions, home"><img class="gv-global-logo" src="${logoPath}" alt="Greyveil Editions" width="156" height="42"></a>
      <button class="gv-global-toggle" type="button" aria-expanded="false" aria-controls="gv-primary-navigation">Menu</button>
      <nav class="gv-global-nav" id="gv-primary-navigation" aria-label="Primary navigation">
        <a href="/#explore">Discover</a><a href="/#mind">The Mind</a><a href="/#human">The Human</a><a href="/#connection">The Connection</a><a href="/#library">The Library</a><a href="/#collective">The Collective</a><a href="/connect/">Connect</a><a href="/contribute/">Contribute</a><a href="/#origin">The Origin</a>
        <a class="gv-global-account" href="/#my-space">Sign in / My Space <span aria-hidden="true">↘</span></a></nav>`;
    legacyHeader.replaceWith(header);
  };
  ensureStyles();
  createSharedHeader();
  applyOfficialWordmark();
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
    nav.addEventListener("click", (event) => { if (event.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.classList.contains("is-open")) { setOpen(false); toggle.focus(); }
    });
    window.addEventListener("resize", () => { if (window.innerWidth > 1120) setOpen(false); }, { passive: true });
  });
  import("/assets/js/site-account-nav.js").catch((error) => console.info("Greyveil account navigation could not be initialized.", {name:error?.name,message:error?.message}));
})();