/*
 * Easy Recommendation — storefront runtime.
 *
 * Framework-free and defensive: this runs inside someone else's theme, so it
 * never throws into their console and never blocks their page. If anything here
 * fails, the worst case is that a recommendation row is missing — never a
 * broken product page.
 *
 * Responsibilities:
 *   1. Fill blocks that Liquid could not render (no override) from Shopify's
 *      Ajax recommendations API.
 *   2. Report served / impression / click / add_to_cart back to the app.
 *   3. Add to cart, tagging the line so the order can be attributed later.
 */
(function () {
  "use strict";

  var DEFAULTS = {
    proxy: "/apps/easy-reco",
    moneyFormat: "${{amount}}",
    enabled: true,
  };

  /** Read at call time, not load time — the app embed may run after this file. */
  function config() {
    var provided = (window.EasyReco && window.EasyReco.config) || {};
    return {
      proxy: provided.proxy || DEFAULTS.proxy,
      moneyFormat: provided.moneyFormat || DEFAULTS.moneyFormat,
      enabled: provided.enabled !== false,
      strings: provided.strings || {},
    };
  }

  function uid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (error) {
      /* fall through */
    }
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Stable for the tab, which is what the server dedupes serves on. Private
   * mode can throw on sessionStorage, so a memory value stands in.
   */
  var memorySession = null;
  function sessionId() {
    if (memorySession) return memorySession;
    try {
      var stored = window.sessionStorage.getItem("easyreco_sid");
      if (!stored) {
        stored = uid();
        window.sessionStorage.setItem("easyreco_sid", stored);
      }
      memorySession = stored;
    } catch (error) {
      memorySession = uid();
    }
    return memorySession;
  }

  /** Which surface a block sits on. Absent means the PDP recommendations block. */
  function placementOf(block) {
    return block.getAttribute("data-reco-placement") || "pdp";
  }

  // --- Beacons -------------------------------------------------------------

  var queue = [];
  var flushTimer = null;
  var MAX_BATCH = 10;

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (queue.length === 0) return;

    var batch = queue.splice(0, MAX_BATCH);
    var url = config().proxy + "/track";
    var body = JSON.stringify({ events: batch });

    try {
      // sendBeacon survives the page being unloaded mid-click, which is exactly
      // when click events fire.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        return;
      }
    } catch (error) {
      /* fall through to fetch */
    }

    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (error) {
      /* give up quietly */
    }
  }

  function track(event) {
    if (!config().enabled) return;

    queue.push({
      clientId: uid(),
      sessionId: sessionId(),
      // One per source: "pdp" (custom), "related", "upsell", "popular",
      // "collection", "recently_viewed". The server keeps them apart so a
      // home-page row never lands in a product's recommendation metrics, and so
      // two recommendation rows on one product page are not deduped into a
      // single serve.
      placement: event.placement || "pdp",
      type: event.type,
      sourceProductId: String(event.sourceProductId),
      recoProductId: event.recoProductId ? String(event.recoProductId) : null,
      source: event.source || "shopify",
    });

    if (queue.length >= MAX_BATCH) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, 1000);
    }
  }

  // Clicks often navigate away before a timer fires.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  // --- Money ---------------------------------------------------------------

  function formatMoney(cents, format) {
    var value = Number(cents || 0) / 100;

    function withDelimiters(number, precision, thousands, decimal) {
      var fixed = number.toFixed(precision);
      var parts = fixed.split(".");
      var whole = parts[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + thousands);
      return parts[1] ? whole + decimal + parts[1] : whole;
    }

    return String(format).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, name) {
      switch (name) {
        case "amount_no_decimals":
          return withDelimiters(value, 0, ",", ".");
        case "amount_with_comma_separator":
          return withDelimiters(value, 2, ".", ",");
        case "amount_no_decimals_with_comma_separator":
          return withDelimiters(value, 0, ".", ",");
        default:
          return withDelimiters(value, 2, ",", ".");
      }
    });
  }

  // --- Rendering the fallback ---------------------------------------------

  function renderFallback(block, products) {
    var template = block.querySelector("[data-reco-card-template]");
    var track_ = block.querySelector("[data-reco-track]");
    if (!template || !track_) return;

    var settings = config();
    var fragment = document.createDocumentFragment();

    products.forEach(function (product) {
      var node = template.content.firstElementChild.cloneNode(true);
      node.setAttribute("data-reco-product-id", product.id);
      node.setAttribute("data-reco-handle", product.handle);

      node.querySelectorAll("[data-reco-link]").forEach(function (link) {
        link.setAttribute("href", product.url);
      });

      var image = node.querySelector(".reco-card__image");
      if (image) {
        if (product.featured_image) {
          image.setAttribute("src", product.featured_image);
          image.setAttribute("alt", product.title || "");
        } else {
          image.classList.add("reco-card__image--placeholder");
          image.removeAttribute("src");
        }
      }

      var title = node.querySelector("[data-reco-title]");
      if (title) title.textContent = product.title;

      var vendor = node.querySelector("[data-reco-vendor]");
      if (vendor) vendor.textContent = product.vendor || "";

      var price = node.querySelector("[data-reco-price]");
      if (price) price.textContent = formatMoney(product.price, settings.moneyFormat);

      var compare = node.querySelector("[data-reco-compare]");
      if (compare && product.compare_at_price > product.price) {
        compare.textContent = formatMoney(product.compare_at_price, settings.moneyFormat);
        compare.hidden = false;
      }

      var button = node.querySelector("[data-reco-add]");
      if (button) {
        var variants = product.variants || [];
        var single = variants.length === 1 && variants[0].available;

        if (!product.available) {
          button.disabled = true;
          button.textContent = settings.strings.soldOut || "Sold out";
        } else if (single) {
          // Same rule as the Liquid card: only auto-add when there is nothing
          // to choose. Otherwise send them to the product page.
          button.setAttribute("data-reco-variant-id", variants[0].id);
        } else {
          var link = document.createElement("a");
          link.className = button.className;
          link.setAttribute("href", product.url);
          link.setAttribute("data-reco-link", "");
          link.textContent = settings.strings.chooseOptions || "Choose options";
          button.replaceWith(link);
        }
      }

      fragment.appendChild(node);
    });

    track_.appendChild(fragment);
  }

  function fetchFallback(block) {
    var productId = block.getAttribute("data-reco-source-product");
    var limit = block.getAttribute("data-reco-limit") || 4;
    var intent = block.getAttribute("data-reco-intent") || "related";

    var url =
      "/recommendations/products.json?product_id=" +
      encodeURIComponent(productId) +
      "&limit=" +
      encodeURIComponent(limit) +
      "&intent=" +
      encodeURIComponent(intent);

    block.setAttribute("data-reco-loading", "true");

    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : { products: [] };
      })
      .then(function (data) {
        var products = (data && data.products) || [];
        block.removeAttribute("data-reco-loading");

        if (products.length === 0) {
          // Nothing to show beats an empty heading floating on the page.
          block.hidden = true;
          return false;
        }

        renderFallback(block, products);
        return true;
      })
      .catch(function () {
        block.removeAttribute("data-reco-loading");
        block.hidden = true;
        return false;
      });
  }


  // --- Recently viewed -----------------------------------------------------

  var RECENT_KEY = "easy-reco:recently-viewed";

  function recentHandles() {
    try {
      var list = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(list)
        ? list.filter(function (handle) {
            return typeof handle === "string" && handle;
          })
        : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Fill a Recently viewed block from the browser's own history.
   *
   * Handles are stored, not product data, so each one is re-fetched from the
   * Ajax API — a price change or a sold-out variant is reflected immediately,
   * and the payload matches what renderFallback already expects.
   *
   * A handle that 404s (product deleted or unpublished since the visit) is
   * dropped silently rather than failing the whole row.
   */
  function loadRecentlyViewed(block) {
    var limit = Number(block.getAttribute("data-reco-limit")) || 4;
    var exclude = block.getAttribute("data-reco-exclude");

    var handles = recentHandles()
      .filter(function (handle) {
        return handle !== exclude;
      })
      .slice(0, limit);

    if (handles.length === 0) {
      if (!block.hasAttribute("data-reco-design-mode")) block.hidden = true;
      return Promise.resolve(false);
    }

    block.setAttribute("data-reco-loading", "true");

    return Promise.all(
      handles.map(function (handle) {
        return fetch("/products/" + encodeURIComponent(handle) + ".js", {
          headers: { Accept: "application/json" },
        })
          .then(function (response) {
            return response.ok ? response.json() : null;
          })
          .catch(function () {
            return null;
          });
      }),
    ).then(function (results) {
      block.removeAttribute("data-reco-loading");

      // Order follows the stored history, so the most recent card comes first.
      var products = results.filter(Boolean);

      if (products.length === 0) {
        if (!block.hasAttribute("data-reco-design-mode")) block.hidden = true;
        return false;
      }

      var hint = block.querySelector("[data-reco-design-hint]");
      if (hint) hint.remove();

      renderFallback(block, products);
      return true;
    });
  }

  // --- Add to cart ---------------------------------------------------------

  function addToCart(block, button) {
    var variantId = button.getAttribute("data-reco-variant-id");
    if (!variantId) return;

    var card = button.closest("[data-reco-card]");
    var sourceProductId = block.getAttribute("data-reco-source-product");
    var recoProductId = card && card.getAttribute("data-reco-product-id");
    var behavior = block.getAttribute("data-reco-atc") || "ajax";
    var clickId = uid();
    var original = button.textContent;

    button.setAttribute("aria-busy", "true");

    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: Number(variantId),
            quantity: 1,
            // Read back by the orders/create webhook to attribute revenue.
            // Underscore-prefixed properties are hidden from the customer.
            properties: {
              _reco_src: sourceProductId,
              _reco_cid: clickId,
              _reco_source: block.getAttribute("data-reco-source") || "shopify",
            },
          },
        ],
      }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("cart/add failed");
        return response.json();
      })
      .then(function () {
        track({
          type: "add_to_cart",
          sourceProductId: sourceProductId,
          recoProductId: recoProductId,
          source: block.getAttribute("data-reco-source"),
          placement: placementOf(block),
        });
        flush();

        if (behavior === "redirect_cart") {
          window.location.href = "/cart";
          return;
        }

        // Themes listen for their own events, so fire the common ones and let
        // whichever the theme understands take over.
        document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
        document.dispatchEvent(new CustomEvent("cart:updated", { bubbles: true }));

        if (behavior === "open_drawer") {
          var drawer = document.querySelector("cart-drawer, #CartDrawer");
          // Dawn-style drawers expose open(); anything else just gets the
          // events above and the button's confirmation state.
          if (drawer && typeof drawer.open === "function") drawer.open();
        }

        button.textContent = config().strings.added || "Added";
        setTimeout(function () {
          button.textContent = original;
        }, 1800);
      })
      .catch(function () {
        button.textContent = config().strings.error || "Try again";
        setTimeout(function () {
          button.textContent = original;
        }, 1800);
      })
      .finally(function () {
        button.removeAttribute("aria-busy");
      });
  }

  // --- Slider --------------------------------------------------------------

  function setupSlider(block) {
    var track_ = block.querySelector("[data-reco-track]");
    var nav = block.querySelector("[data-reco-nav]");
    if (!track_ || !nav) return;

    var prev = nav.querySelector("[data-reco-prev]");
    var next = nav.querySelector("[data-reco-next]");

    function overflowing() {
      return track_.scrollWidth > track_.clientWidth + 4;
    }

    function sync() {
      nav.hidden = !overflowing();
      if (nav.hidden) return;
      prev.disabled = track_.scrollLeft <= 2;
      next.disabled = track_.scrollLeft + track_.clientWidth >= track_.scrollWidth - 2;
    }

    function page(direction) {
      var card = track_.querySelector("[data-reco-card]");
      var step = card ? card.offsetWidth + 16 : track_.clientWidth;
      track_.scrollBy({ left: step * direction, behavior: "smooth" });
    }

    prev.addEventListener("click", function () {
      page(-1);
    });
    next.addEventListener("click", function () {
      page(1);
    });
    track_.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    sync();

    var wantsAutoplay = block.getAttribute("data-reco-autoplay") === "true";
    var reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (wantsAutoplay && !reduced) {
      var seconds = Number(block.getAttribute("data-reco-autoplay-speed")) || 4;
      var timer = setInterval(function () {
        if (!overflowing()) return;
        if (next.disabled) {
          track_.scrollTo({ left: 0, behavior: "smooth" });
        } else {
          page(1);
        }
      }, seconds * 1000);

      // Stop fighting the shopper the moment they take control.
      ["pointerdown", "focusin"].forEach(function (name) {
        block.addEventListener(name, function () {
          clearInterval(timer);
        }, { once: true });
      });
    }
  }

  // --- Tracking wiring -----------------------------------------------------

  function observeImpressions(block) {
    if (!("IntersectionObserver" in window)) return;

    var sourceProductId = block.getAttribute("data-reco-source-product");
    var source = block.getAttribute("data-reco-source");
    var placement = placementOf(block);

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          // Once per card per page view.
          observer.unobserve(entry.target);
          track({
            type: "impression",
            sourceProductId: sourceProductId,
            recoProductId: entry.target.getAttribute("data-reco-product-id"),
            source: source,
            placement: placement,
          });
        });
      },
      { threshold: 0.5 },
    );

    block.querySelectorAll("[data-reco-card]").forEach(function (card) {
      observer.observe(card);
    });
  }

  function wire(block) {
    observeImpressions(block);

    var sourceProductId = block.getAttribute("data-reco-source-product");
    var source = block.getAttribute("data-reco-source");
    var placement = placementOf(block);

    block.addEventListener("click", function (event) {
      var button = event.target.closest("[data-reco-add]");
      if (button) {
        event.preventDefault();
        addToCart(block, button);
        return;
      }

      var link = event.target.closest("[data-reco-link]");
      if (!link) return;

      var card = link.closest("[data-reco-card]");
      track({
        type: "click",
        sourceProductId: sourceProductId,
        recoProductId: card && card.getAttribute("data-reco-product-id"),
        source: source,
        placement: placement,
      });
      flush();
    });

    if (block.classList.contains("reco--slider")) setupSlider(block);

    // One serve per widget that actually showed something. Sent from here
    // rather than the server because the override path renders in Liquid and
    // never reaches the app.
    //
    // Sent by the custom and related sources. Opted out by popular and
    // recently viewed: those are merchandising, not recommendation, so they
    // report engagement but cost no quota.
    if (block.getAttribute("data-reco-serve") !== "false") {
      track({
        type: "served",
        sourceProductId: sourceProductId,
        source: source,
        placement: placement,
      });
    }
  }


  // --- Upsell (frequently bought together) ---------------------------------

  /*
   * A bundle, not a row of cards: several lines the shopper ticks, one running
   * total, and one /cart/add.js call carrying every ticked variant. It lives
   * here rather than in its own asset so it can reuse the beacon queue, the
   * session id and the money formatter directly, with no load-order dependency
   * between two files.
   */

  function upsellRows(block) {
    return Array.prototype.slice.call(block.querySelectorAll("[data-upsell-row]"));
  }

  /** The variant a row currently resolves to: its picker, else its checkbox. */
  function rowVariantId(row) {
    var select = row.querySelector("[data-upsell-variant]");
    if (select && !select.hidden && select.value) return select.value;

    var check = row.querySelector("[data-upsell-check]");
    return check ? check.value : null;
  }

  function rowCents(row) {
    var select = row.querySelector("[data-upsell-variant]");
    if (select && !select.hidden) {
      var option = select.options[select.selectedIndex];
      if (option) return Number(option.getAttribute("data-upsell-cents") || 0);
    }
    var price = row.querySelector("[data-upsell-price]");
    return Number((price && price.getAttribute("data-upsell-cents")) || 0);
  }

  /**
   * The theme owns the variant picker on the page, and most themes record a
   * change by rewriting ?variant= without firing popstate — so the current row
   * is resolved from the URL at the moment it is read rather than trusted from
   * render time.
   */
  function currentVariantId(row) {
    try {
      var fromUrl = new URL(window.location.href).searchParams.get("variant");
      if (fromUrl) return fromUrl;
    } catch (error) {
      /* fall through to the rendered value */
    }
    return rowVariantId(row);
  }

  function label(block, name) {
    return block.getAttribute("data-upsell-" + name) || "";
  }

  function refreshUpsell(block) {
    var total = 0;
    var count = 0;

    upsellRows(block).forEach(function (row) {
      var check = row.querySelector("[data-upsell-check]");
      var on = check && check.checked;
      row.classList.toggle("upsell__row--off", !on);
      if (!on) return;
      count += 1;
      total += rowCents(row);

      var price = row.querySelector("[data-upsell-price]");
      var select = row.querySelector("[data-upsell-variant]");
      // Keep the row's own price honest when its variant changes.
      if (price && select && !select.hidden) {
        price.textContent = formatMoney(rowCents(row), config().moneyFormat);
      }
    });

    var totalText = block.querySelector("[data-upsell-total-text]");
    var totalValue = block.querySelector("[data-upsell-total]");
    var button = block.querySelector("[data-upsell-add]");

    if (totalText) {
      totalText.textContent = count
        ? label(block, "total-label").replace("[count]", String(count))
        : "";
    }
    if (totalValue) {
      totalValue.textContent = count ? formatMoney(total, config().moneyFormat) : "";
    }
    if (button) {
      button.textContent = count === 0
        ? label(block, "add-none")
        : count === 1
          ? label(block, "add-one")
          : label(block, "add-many").replace("[count]", String(count));
      button.disabled = count === 0;
    }
  }

  /** Build the rows reco.js had to fetch, from Shopify's product JSON. */
  function renderUpsellRows(block, products) {
    var template = block.querySelector("[data-upsell-row-template]");
    var list = block.querySelector("[data-upsell-list]");
    if (!template || !list) return false;

    var limit = Number(block.getAttribute("data-reco-limit") || 3);
    var sourceProductId = block.getAttribute("data-reco-source-product");
    var showImage = block.getAttribute("data-upsell-show-image") !== "false";
    var showCompare = block.getAttribute("data-upsell-show-compare") !== "false";
    var format = config().moneyFormat;
    var fragment = document.createDocumentFragment();
    var rendered = 0;

    products.forEach(function (item) {
      if (rendered >= limit) return;
      if (String(item.id) === String(sourceProductId)) return;

      var sellable = (item.variants || []).filter(function (variant) {
        return variant.available;
      });
      // A bundle line that cannot be bought would fail the whole add.
      if (sellable.length === 0) return;

      var node = template.content.firstElementChild.cloneNode(true);
      var rowId = "ups-fetched-" + item.id;

      node.setAttribute("data-reco-product-id", String(item.id));
      node.setAttribute("data-upsell-handle", item.handle || "");

      var check = node.querySelector("[data-upsell-check]");
      var checkLabel = node.querySelector(".upsell__label");
      check.id = rowId;
      check.value = String(sellable[0].id);
      if (checkLabel) checkLabel.setAttribute("for", rowId);

      var image = node.querySelector("[data-upsell-image]");
      if (image) {
        if (showImage && item.featured_image) {
          image.src = item.featured_image;
          image.alt = item.title || "";
        } else {
          image.remove();
        }
      }

      var title = node.querySelector("[data-upsell-title]");
      if (title) title.textContent = item.title || "";

      var select = node.querySelector("[data-upsell-variant]");
      if (select) {
        if (sellable.length > 1) {
          select.setAttribute("aria-label", label(block, "choose-variant"));
          sellable.forEach(function (variant) {
            var option = document.createElement("option");
            option.value = String(variant.id);
            option.textContent = variant.title;
            option.setAttribute("data-upsell-cents", String(variant.price));
            select.appendChild(option);
          });
          select.hidden = false;
        } else {
          select.remove();
        }
      }

      var price = node.querySelector("[data-upsell-price]");
      if (price) {
        price.setAttribute("data-upsell-cents", String(sellable[0].price));
        price.textContent = formatMoney(sellable[0].price, format);
      }

      var compare = node.querySelector("[data-upsell-compare]");
      if (compare) {
        if (showCompare && item.compare_at_price > sellable[0].price) {
          compare.textContent = formatMoney(item.compare_at_price, format);
          compare.hidden = false;
        } else {
          compare.remove();
        }
      }

      var link = node.querySelector("[data-upsell-view-link]");
      if (link) {
        link.href = item.url || "/products/" + item.handle;
        link.textContent = label(block, "view");
      }

      fragment.appendChild(node);
      rendered += 1;
    });

    if (rendered === 0) return false;
    list.appendChild(fragment);
    return true;
  }

  function fetchUpsell(block) {
    var productId = block.getAttribute("data-reco-source-product");
    var limit = block.getAttribute("data-reco-limit") || 3;

    var url =
      "/recommendations/products.json?product_id=" +
      encodeURIComponent(productId) +
      // Shopify excludes sold-out products itself, but an over-fetch leaves room
      // for the ones this block drops for having no sellable variant.
      "&limit=" +
      encodeURIComponent(Math.min(Number(limit) + 4, 10)) +
      "&intent=related";

    block.setAttribute("data-reco-loading", "true");

    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : { products: [] };
      })
      .then(function (data) {
        block.removeAttribute("data-reco-loading");
        return renderUpsellRows(block, (data && data.products) || []);
      })
      .catch(function () {
        block.removeAttribute("data-reco-loading");
        return false;
      });
  }

  function addUpsellToCart(block, button) {
    var rows = upsellRows(block).filter(function (row) {
      var check = row.querySelector("[data-upsell-check]");
      return check && check.checked;
    });
    if (rows.length === 0) return;

    var sourceProductId = block.getAttribute("data-reco-source-product");
    var source = block.getAttribute("data-reco-source") || "shopify";
    var behavior = block.getAttribute("data-reco-atc") || "ajax";

    var items = [];
    var attributed = [];

    rows.forEach(function (row) {
      var isCurrent = row.hasAttribute("data-upsell-current");
      var variantId = isCurrent ? currentVariantId(row) : rowVariantId(row);
      if (!variantId) return;

      var clickId = uid();
      items.push({
        id: Number(variantId),
        quantity: 1,
        // The source product is never attributed to itself: its line carries no
        // reco properties, so the orders/create webhook does not book the
        // shopper's own product as a recommendation-driven sale.
        properties: isCurrent
          ? {}
          : {
              _reco_src: sourceProductId,
              _reco_cid: clickId,
              _reco_source: source,
            },
      });

      if (!isCurrent) {
        attributed.push(row.getAttribute("data-reco-product-id"));
      }
    });

    if (items.length === 0) return;

    button.setAttribute("aria-busy", "true");
    button.disabled = true;

    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items: items }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("cart/add failed");
        return response.json();
      })
      .then(function () {
        // One event per recommended line, so a three-product bundle reports
        // three add_to_carts rather than one.
        attributed.forEach(function (recoProductId) {
          track({
            type: "add_to_cart",
            sourceProductId: sourceProductId,
            recoProductId: recoProductId,
            source: source,
            placement: "upsell",
          });
        });
        flush();

        if (behavior === "redirect_cart") {
          window.location.href = "/cart";
          return;
        }

        document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
        document.dispatchEvent(new CustomEvent("cart:updated", { bubbles: true }));

        if (behavior === "open_drawer") {
          var drawer = document.querySelector("cart-drawer, #CartDrawer");
          if (drawer && typeof drawer.open === "function") drawer.open();
        }

        button.textContent = config().strings.added || "Added";
        setTimeout(function () {
          button.disabled = false;
          refreshUpsell(block);
        }, 1800);
      })
      .catch(function () {
        button.textContent = config().strings.error || "Try again";
        setTimeout(function () {
          button.disabled = false;
          refreshUpsell(block);
        }, 1800);
      })
      .finally(function () {
        // The label is not restored here: refreshUpsell() rewrites it from the
        // live tick count once the confirmation has been shown.
        button.removeAttribute("aria-busy");
      });
  }

  function wireUpsell(block) {
    observeImpressions(block);

    var sourceProductId = block.getAttribute("data-reco-source-product");
    var source = block.getAttribute("data-reco-source");

    block.addEventListener("change", function (event) {
      if (!event.target.closest("[data-upsell-check], [data-upsell-variant]")) return;
      refreshUpsell(block);

      // Ticking a line is this block's engagement signal — there are no
      // per-card buttons to click — so it reports `click`, once per row per page
      // view, keeping impression → click → add_to_cart intact.
      var row = event.target.closest("[data-upsell-row]");
      var check = event.target.closest("[data-upsell-check]");
      if (!row || !check || !check.checked) return;
      if (row.hasAttribute("data-upsell-current")) return;
      if (row.hasAttribute("data-upsell-clicked")) return;
      row.setAttribute("data-upsell-clicked", "true");

      track({
        type: "click",
        sourceProductId: sourceProductId,
        recoProductId: row.getAttribute("data-reco-product-id"),
        source: source,
        placement: "upsell",
      });
    });

    block.addEventListener("click", function (event) {
      var button = event.target.closest("[data-upsell-add]");
      if (button) {
        event.preventDefault();
        addUpsellToCart(block, button);
        return;
      }

      var link = event.target.closest("[data-reco-link]");
      if (!link) return;

      var row = link.closest("[data-upsell-row]");
      if (row && !row.hasAttribute("data-upsell-clicked")) {
        row.setAttribute("data-upsell-clicked", "true");
        track({
          type: "click",
          sourceProductId: sourceProductId,
          recoProductId: row.getAttribute("data-reco-product-id"),
          source: source,
          placement: "upsell",
        });
        flush();
      }
    });

    refreshUpsell(block);

    // Billable like Custom and Related: it has a source product and answers
    // "what goes with this", so one serve per render that showed something.
    track({
      type: "served",
      sourceProductId: sourceProductId,
      source: source,
      placement: "upsell",
    });
  }

  function initUpsell() {
    document.querySelectorAll("[data-upsell-block]").forEach(function (block) {
      if (block.hasAttribute("data-upsell-ready")) return;
      block.setAttribute("data-upsell-ready", "true");
      // Claimed here so the card-based init below skips it.
      block.setAttribute("data-reco-ready", "true");

      if (block.getAttribute("data-reco-server-rendered") === "true") {
        wireUpsell(block);
        return;
      }

      fetchUpsell(block).then(function (rendered) {
        if (rendered) {
          wireUpsell(block);
          return;
        }
        // Nothing to bundle with. A lone "This item" row with a total is not an
        // upsell, so the block removes itself rather than pretending.
        if (!block.querySelector("[data-reco-card]")) block.remove();
      });
    });
  }

  function init() {
    // Upsell blocks first: they mark themselves ready so the card loop skips
    // them, since both carry data-reco-block for the shared tracking wiring.
    initUpsell();

    document.querySelectorAll("[data-reco-block]").forEach(function (block) {
      if (block.hasAttribute("data-reco-ready")) return;
      block.setAttribute("data-reco-ready", "true");

      if (block.getAttribute("data-reco-server-rendered") === "true") {
        wire(block);
        return;
      }

      var load =
        block.getAttribute("data-reco-mode") === "recent"
          ? loadRecentlyViewed(block)
          : fetchFallback(block);

      load.then(function (rendered) {
        if (rendered) wire(block);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Theme editor re-renders sections without a page load.
  document.addEventListener("shopify:section:load", init);

  window.EasyReco = window.EasyReco || {};
  window.EasyReco.init = init;
})();
