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

  /*
   * Run once per page, whatever loads us.
   *
   * Three blocks declare this file through their schema `javascript` key, and the
   * app embed loads it with its own <script src> so an offer can render with no
   * block present (§7.6). A page with both gets two identical script tags: the
   * browser serves the second from cache but *executes* it, which would mean two
   * beacon queues, two sets of listeners, and a second init racing the first.
   *
   * The DOM markers (data-reco-ready, data-reco-embedded) already stop double
   * rendering, but they do not stop double instrumenting — so the guard is here.
   */
  window.EasyReco = window.EasyReco || {};
  if (window.EasyReco.loaded) return;
  window.EasyReco.loaded = true;

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

  /** The offer the app embed inlined for this product page, if any. */
  function embeddedOffer() {
    return (window.EasyReco && window.EasyReco.offer) || null;
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

    // The server caps a batch at 10 as well, so a full queue leaves a tail
    // behind. The timer was just cleared, so without re-arming it the leftovers
    // wait for the next event — or are lost to the navigation that triggered
    // this flush. A grid of 12 cards hits this on its first screenful.
    if (queue.length > 0) flushTimer = setTimeout(flush, 250);

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

  /**
   * A timer cannot fire after the page is gone, so the queue is drained in a
   * loop instead of one batch at a time.
   */
  function flushAll() {
    var guard = 0;
    while (queue.length > 0 && guard < 20) {
      flush();
      guard += 1;
    }
  }

  /**
   * `served` is exempt from the tracking toggle, deliberately.
   *
   * It is not an analytics event: it is the billing signal (CLAUDE.md §3.3), and
   * on the theme path it is the *only* signal, because an override renders from
   * the metafield and the Ajax fallback never reaches the app either. Letting
   * the app embed's "Track recommendation performance" checkbox suppress it
   * would turn that checkbox into unlimited free recommendations.
   */
  function track(event) {
    if (!config().enabled && event.type !== "served") return;

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
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAll();
  });

  // --- Money ---------------------------------------------------------------

  /**
   * The shop's money format, read from the block before the app embed.
   *
   * The embed publishes it too, but the embed is optional and every block is
   * built to work without it — so a store selling in EUR that never enabled it
   * would render "$" on every client-rendered price. Worse in the Bought
   * Together block, where Liquid formats the row prices correctly and only the
   * running total underneath would be wrong.
   */
  function moneyFormat(block) {
    return (
      (block && block.getAttribute("data-reco-money-format")) ||
      config().moneyFormat
    );
  }

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
    var format = moneyFormat(block);
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
      if (price) price.textContent = formatMoney(product.price, format);

      var compare = node.querySelector("[data-reco-compare]");
      if (compare && product.compare_at_price > product.price) {
        compare.textContent = formatMoney(product.compare_at_price, format);
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
          /*
           * In the theme editor, say why. An empty list here is usually not a
           * fault: Shopify answers `complementary` only for products a merchant
           * has linked in the Search & Discovery app, so an untouched store gets
           * nothing back — and a row that silently removed itself looks like the
           * source is broken.
           *
           * On the live storefront it still just goes: nothing to show beats an
           * empty heading floating on the page.
           */
          if (block.hasAttribute("data-reco-design-mode")) {
            var emptyHint = block.querySelector("[data-reco-design-hint]");
            if (emptyHint) emptyHint.hidden = false;
            return false;
          }

          block.hidden = true;
          return false;
        }

        var hint = block.querySelector("[data-reco-design-hint]");
        if (hint) hint.remove();

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

  /**
   * Autoplay intervals, so a block that leaves the DOM takes its timer with it.
   * The theme editor re-renders a section on every settings change, and an
   * orphaned interval keeps scrolling a detached node for the rest of the
   * session.
   */
  var autoplayTimers = [];

  document.addEventListener("shopify:section:unload", function () {
    autoplayTimers = autoplayTimers.filter(function (entry) {
      if (document.contains(entry.block)) return true;
      clearInterval(entry.timer);
      return false;
    });
  });

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

      autoplayTimers.push({ block: block, timer: timer });

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
        price.textContent = formatMoney(rowCents(row), moneyFormat(block));
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
      totalValue.textContent = count ? formatMoney(total, moneyFormat(block)) : "";
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
    var format = moneyFormat(block);
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

  // --- App embed injection -------------------------------------------------

  /*
   * Anchors tried in order when the offer names none of its own.
   *
   * Every one of these is a place the add-to-cart button lives in a
   * Dawn-family theme. Ordered most specific first: matching the button's own
   * container puts the offer directly under the buy area, whereas the last two
   * are whole-section fallbacks that at least keep it inside the product
   * details rather than at the end of the document.
   */
  var ANCHORS = [
    '.product-form__buttons',
    'form[action*="/cart/add"] .product-form__submit',
    'form[action*="/cart/add"] [type="submit"]',
    '.shopify-payment-button',
    'product-form',
    'form[action*="/cart/add"]',
    '.product__info-wrapper',
    '.product-single__meta',
  ];

  /**
   * Is this element actually on screen?
   *
   * Themes ship duplicate buy forms for their cart drawer and quick-add modals,
   * and injecting into one puts the offer somewhere the shopper never sees. So
   * the chain skips hidden candidates.
   *
   * Deliberately *not* `offsetParent !== null`, which is the usual shorthand: it
   * reports null for `position: fixed` elements too, so a theme with a sticky
   * add-to-cart bar would have its only anchor rejected. This walks the ancestors
   * instead, which needs no layout and gives the same answer for the case that
   * matters.
   */
  function isVisible(element) {
    var view = element.ownerDocument && element.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return true;

    for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute("hidden")) return false;

      var style = view.getComputedStyle(node);
      if (style && (style.display === "none" || style.visibility === "hidden")) {
        return false;
      }
    }

    return true;
  }

  function findAnchor(offer) {
    var selectors = [];

    // The merchant's own selector is tried first and the built-in chain still
    // follows it: a theme update that renames a class should degrade to a
    // slightly worse position, not to nothing rendering at all.
    if (offer.render && offer.render.selector) selectors.push(offer.render.selector);
    selectors = selectors.concat(ANCHORS);

    for (var i = 0; i < selectors.length; i += 1) {
      try {
        // All matches, not the first: a hidden duplicate earlier in the document
        // must not consume the selector's turn in the chain.
        var found = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < found.length; j += 1) {
          if (isVisible(found[j]) && found[j].parentNode) return found[j];
        }
      } catch (error) {
        /* an invalid selector from the merchant must not stop the chain */
      }
    }

    return null;
  }

  /**
   * Offer types the admin previews as a carousel: one product at a time, laid out
   * as a row.
   *
   * Frequently bought together is a stacked bundle with a running total (§7.4) and
   * a volume discount is a list of quantity tiers, so neither scrolls — both keep
   * the grid. Kept in step with CAROUSEL_TYPES in app/routes/app.offers.new.jsx:
   * the whole point of the preview is that it is what the shopper gets.
   */
  var CAROUSEL_OFFER_TYPES = { cross_sell: true, product_add_on: true };

  function offerIsCarousel(offer) {
    if (offer.type) return CAROUSEL_OFFER_TYPES[offer.type] === true;

    /*
     * No type means a metafield written before offers carried one. `copy` is only
     * ever written by an offer publish, so its presence still identifies one, and
     * cross-sell is what an offer defaults to — without this an already published
     * offer would keep the old grid until someone happened to re-publish it. A
     * list curated on the recommendations page has no copy and stays a grid.
     */
    return Boolean(offer.copy);
  }

  /**
   * A slider arrow, drawn rather than typed.
   *
   * These were the `‹` and `›` text glyphs, which every theme font renders at a
   * different weight, size and baseline — thin and sitting slightly high in most
   * of them. An SVG is the same shape in every theme, and it inherits the
   * button's colour through `currentColor`. Kept identical to the copy in
   * `snippets/reco-panel.liquid`, which draws the block's own slider nav.
   */
  function chevron(direction) {
    return (
      '<svg class="reco__nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="' +
      (direction === "prev" ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7") +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"/></svg>'
    );
  }

  /** The container the embed renders into, shaped like reco-panel's output. */
  function buildBlock(offer) {
    var copy = offer.copy || {};
    var strings = config().strings || {};
    var carousel = offerIsCarousel(offer);
    var block = document.createElement("div");

    /*
     * The carousel reuses the slider layout rather than introducing a second
     * scroller: `reco--slider` brings the scroll-snap CSS and makes wire() call
     * setupSlider, and one column per view is just the column count set to 1.
     * `reco--offer` is what turns each card into a row — image, then title and
     * price, with the button on the trailing edge.
     */
    block.className =
      "reco reco--align-left reco--embedded " +
      (carousel ? "reco--slider reco--offer" : "reco--grid");
    block.setAttribute("data-reco-block", "");
    block.setAttribute("data-reco-embedded", "true");
    block.setAttribute("data-reco-placement", "pdp");
    block.setAttribute("data-reco-source-product", String(offer.productId));
    block.setAttribute("data-reco-source", "override");
    block.setAttribute("data-reco-intent", "related");
    block.setAttribute("data-reco-limit", String(offer.items.length));
    block.setAttribute("data-reco-atc", "ajax");
    block.setAttribute("data-reco-money-format", config().moneyFormat);
    // Products came inlined, so there is nothing to fetch — but the cards are
    // still drawn by renderFallback, which needs the template below.
    block.setAttribute("data-reco-server-rendered", "false");

    if (carousel) {
      block.style.setProperty("--reco-columns-mobile", "1");
      block.style.setProperty("--reco-columns-desktop", "1");
    }

    /*
     * Arrows sit in the header beside the title, which is where the offer editor
     * previews them, rather than overlaid on the row as the theme block's slider
     * does. They start hidden: setupSlider unhides them only when the track
     * actually overflows, so a one-product offer shows no controls.
     */
    var nav = carousel
      ? '<div class="reco__nav reco__nav--header" data-reco-nav hidden>' +
        '<button type="button" class="reco__nav-button" data-reco-prev aria-label="' +
        escapeHtml(strings.previous || "Previous") +
        '">' +
        chevron("prev") +
        "</button>" +
        '<button type="button" class="reco__nav-button" data-reco-next aria-label="' +
        escapeHtml(strings.next || "Next") +
        '">' +
        chevron("next") +
        "</button>" +
        "</div>"
      : "";

    // The header is also what holds the nav, so a carousel with no title still
    // needs one — otherwise the arrows would have nowhere to go.
    var heading =
      copy.title || nav
        ? '<div class="reco__header">' +
          (copy.title
            ? '<h2 class="reco__heading reco__heading--md">' + escapeHtml(copy.title) + "</h2>"
            : "") +
          (copy.badge ? '<span class="reco__badge">' + escapeHtml(copy.badge) + "</span>" : "") +
          nav +
          "</div>"
        : "";

    var button =
      '<button type="button" class="reco-card__button reco-card__button--solid" data-reco-add>' +
      escapeHtml(copy.buttonText || strings.addToCart || "Add to cart") +
      "</button>";

    var info =
      '<div class="reco-card__info">' +
      '<a class="reco-card__title" data-reco-link data-reco-title></a>' +
      '<span class="reco-card__price"><span data-reco-price></span>' +
      '<s class="reco-card__compare" data-reco-compare hidden></s></span>' +
      // In a row the button is a column of its own, beside the text rather than
      // under it. renderFallback finds it either way — it queries the whole card.
      (carousel ? "" : button) +
      "</div>";

    block.innerHTML =
      heading +
      '<div class="reco__viewport"><div class="reco__track" data-reco-track></div></div>' +
      "<template data-reco-card-template>" +
      '<div class="reco-card" data-reco-card>' +
      '<a class="reco-card__media" data-reco-link>' +
      '<img class="reco-card__image" width="400" height="400" loading="lazy" alt="">' +
      "</a>" +
      info +
      (carousel ? button : "") +
      "</div>" +
      "</template>";

    return block;
  }

  /** Text into markup. The copy is merchant-authored, so it is never trusted. */
  function escapeHtml(value) {
    var node = document.createElement("span");
    node.textContent = String(value == null ? "" : value);
    return node.innerHTML;
  }

  /**
   * Render the embed's offer, when there is no theme block already doing it.
   *
   * The block always wins: a merchant who placed one has said where they want it,
   * and rendering both would show the same products twice and bill two serves for
   * one page (§3.3).
   */
  function initEmbeddedOffer() {
    var offer = embeddedOffer();
    if (!offer || !offer.items || offer.items.length === 0) return;

    // Already handled, or a theme block owns this placement.
    if (document.querySelector("[data-reco-embedded]")) return;
    if (document.querySelector('[data-reco-block][data-reco-placement="pdp"]')) return;

    var anchor = findAnchor(offer);
    if (!anchor) return;

    var block = buildBlock(offer);
    var position = offer.render && offer.render.position === "before" ? "before" : "after";

    if (position === "before") {
      anchor.parentNode.insertBefore(block, anchor);
    } else {
      anchor.parentNode.insertBefore(block, anchor.nextSibling);
    }

    renderFallback(block, offer.items);
    block.setAttribute("data-reco-ready", "true");
    wire(block);
  }

  function init() {
    // Before the block loops: if a theme block is present it owns the placement,
    // and this checks for one.
    initEmbeddedOffer();

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

  // Namespace was created by the load guard at the top.
  window.EasyReco.init = init;
})();
