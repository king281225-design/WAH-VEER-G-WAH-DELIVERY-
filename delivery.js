/* =========================================================================
   WAH VEER G WAH — CART & HOME DELIVERY
   Client-side cart, 2km geolocation verification, guest checkout, and order
   confirmation. No backend — orders are (a) saved to this browser's
   localStorage for the on-device Order Management screen, and (b) sent to
   the restaurant via a WhatsApp click-to-chat link so they reliably reach
   the restaurant regardless of device.
   ========================================================================= */

(function () {
  "use strict";

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const CART_KEY = "wvgw_cart_v1";
  const ORDERS_KEY = "wvgw_orders_v1";

  /* ---------------------------------------------------------- state */
  let cart = loadCart();
  let deliveryLocation = null; // { lat, lng, distanceKm }
  let step = "cart"; // cart | details | confirm-location-fail | review | done

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
  }
  function cartCount() {
    return Object.values(cart).reduce((sum, l) => sum + l.qty, 0);
  }
  function cartTotal() {
    return Object.values(cart).reduce((sum, l) => sum + l.qty * l.price, 0);
  }

  /* ---------------------------------------------------------- distance (Haversine) */
  function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------------------------------------------------------- validation */
  function validName(v) { return v.trim().length >= 2; }
  function validAddress(v) { return v.trim().length >= 8; }
  function normalizePhone(v) {
    let digits = v.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    // Only strip a country/trunk code prefix when the total length proves
    // it's actually there — e.g. "9123456780" (10 digits) is a valid
    // number in its own right and must NOT be mistaken for "91" + a
    // truncated number just because it starts with those two digits.
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return digits;
  }
  function validIndianPhone(v) {
    return /^[6-9]\d{9}$/.test(normalizePhone(v));
  }

  /* ---------------------------------------------------------- cart mutation (called from menu cards) */
  function addToCart(key, name, variant, price) {
    if (!cart[key]) cart[key] = { key, name, variant, price, qty: 0 };
    cart[key].qty += 1;
    saveCart();
    renderAll();
  }
  function decFromCart(key) {
    if (!cart[key]) return;
    cart[key].qty -= 1;
    if (cart[key].qty <= 0) delete cart[key];
    saveCart();
    renderAll();
  }
  function removeFromCart(key) {
    delete cart[key];
    saveCart();
    renderAll();
  }

  /* ---------------------------------------------------------- render: qty badges on menu cards */
  function renderAll() {
    renderCartBadges();
    renderFab();
    renderDrawer();
  }

  function renderCartBadges() {
    $$("[data-cart-key]").forEach((el) => {
      const key = el.dataset.cartKey;
      const qty = cart[key] ? cart[key].qty : 0;
      const addBtn = el.querySelector(".ctrl-add");
      const stepper = el.querySelector(".ctrl-stepper");
      const qtyEl = el.querySelector(".ctrl-qty");
      if (qty > 0) {
        if (addBtn) addBtn.style.display = "none";
        if (stepper) stepper.style.display = "flex";
        if (qtyEl) qtyEl.textContent = qty;
      } else {
        if (addBtn) addBtn.style.display = "";
        if (stepper) stepper.style.display = "none";
      }
    });
  }

  function renderFab() {
    const fab = $("#delivery-fab");
    if (!fab) return;
    const count = cartCount();
    const badge = $("#delivery-fab-badge");
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? "flex" : "none";
    }
  }

  /* ---------------------------------------------------------- drawer open/close */
  function openDrawer(initialStep) {
    step = initialStep || (cartCount() > 0 ? "cart" : "cart");
    $("#delivery-drawer")?.classList.add("open");
    $("#delivery-backdrop")?.classList.add("open");
    document.body.style.overflow = "hidden";
    renderDrawer();
  }
  function closeDrawer() {
    $("#delivery-drawer")?.classList.remove("open");
    $("#delivery-backdrop")?.classList.remove("open");
    document.body.style.overflow = "";
  }

  /* ---------------------------------------------------------- drawer content per step */
  function renderDrawer() {
    const body = $("#drawer-body");
    if (!body) return;

    if (step === "cart") body.innerHTML = cartStepHTML();
    else if (step === "details") body.innerHTML = detailsStepHTML();
    else if (step === "locating") body.innerHTML = locatingStepHTML();
    else if (step === "low-accuracy") body.innerHTML = lowAccuracyStepHTML();
    else if (step === "too-far") body.innerHTML = tooFarStepHTML();
    else if (step === "review") body.innerHTML = reviewStepHTML();
    else if (step === "done") body.innerHTML = doneStepHTML();

    wireStepEvents();
  }

  function cartStepHTML() {
    const lines = Object.values(cart);
    if (!lines.length) {
      return `
        <div class="drawer-empty">
          <div class="drawer-empty-icon">🛒</div>
          <p>Your cart is empty. Add a few dishes from the menu to get started.</p>
          <button class="btn btn-primary" data-action="browse-menu">Browse Menu</button>
        </div>`;
    }
    const rows = lines
      .map(
        (l) => `
        <div class="cart-line">
          <div class="cart-line-info">
            <div class="cart-line-name">${l.name}</div>
            <div class="cart-line-variant">${l.variant} · ₹${l.price} each</div>
          </div>
          <div class="ctrl-stepper" style="display:flex">
            <button class="ctrl-btn" data-action="dec" data-key="${l.key}" aria-label="Decrease">−</button>
            <span class="ctrl-qty">${l.qty}</span>
            <button class="ctrl-btn" data-action="inc" data-key="${l.key}" aria-label="Increase">+</button>
          </div>
          <div class="cart-line-total">₹${l.qty * l.price}</div>
        </div>`
      )
      .join("");
    return `
      <div class="delivery-badge-row">
        <span class="delivery-avail-badge">🏠 Home delivery available within ${CONFIG.DELIVERY_RADIUS_KM} KM</span>
      </div>
      <div class="cart-lines">${rows}</div>
      <div class="cart-summary-row">
        <span>Subtotal</span>
        <span>₹${cartTotal()}</span>
      </div>
      <button class="btn btn-primary drawer-cta" data-action="go-details">Proceed to Delivery Details</button>`;
  }

  function detailsStepHTML() {
    const d = window.__wvgwDraft || {};
    return `
      <button class="drawer-back" data-action="back-to-cart">← Back to cart</button>
      <h3 class="drawer-h">Delivery Details</h3>
      <label class="dform-label" for="d-name">Your Name *</label>
      <input class="dform-input" id="d-name" type="text" placeholder="Full name" value="${d.name || ""}" />
      <div class="dform-err" id="err-name"></div>

      <label class="dform-label" for="d-phone">Phone Number *</label>
      <input class="dform-input" id="d-phone" type="tel" inputmode="numeric" placeholder="10-digit mobile number" value="${d.phone || ""}" />
      <div class="dform-err" id="err-phone"></div>

      <label class="dform-label" for="d-address">Complete Delivery Address *</label>
      <textarea class="dform-input" id="d-address" rows="3" placeholder="House/flat no., street, area">${d.address || ""}</textarea>
      <div class="dform-err" id="err-address"></div>

      <label class="dform-label" for="d-landmark">Landmark (optional)</label>
      <input class="dform-input" id="d-landmark" type="text" placeholder="e.g. near Tilak Nagar Metro Station" value="${d.landmark || ""}" />

      <button class="btn btn-primary drawer-cta" data-action="check-location">📍 Confirm My Location &amp; Continue</button>
      <p class="dform-note">We use your device location just once, to confirm you're within our ${CONFIG.DELIVERY_RADIUS_KM} KM delivery zone. We don't track or store it beyond this order.</p>`;
  }

  function locatingStepHTML() {
    return `
      <div class="drawer-empty">
        <div class="drawer-empty-icon">📍</div>
        <p>Checking your location — please allow location access if your browser asks. For the most accurate result, make sure GPS is turned on.</p>
      </div>`;
  }

  function lowAccuracyStepHTML() {
    const acc = deliveryLocation ? Math.round(deliveryLocation.accuracy) : "?";
    return `
      <button class="drawer-back" data-action="back-to-details">← Back</button>
      <div class="drawer-empty">
        <div class="drawer-empty-icon">📡</div>
        <p class="too-far-msg">Your location isn't precise enough to confirm delivery.</p>
        <p class="dform-note">Your device reported a location accurate to only about ${acc}m — that's too rough to reliably check our ${CONFIG.DELIVERY_RADIUS_KM} KM zone. This usually happens with Wi-Fi/IP-based location instead of real GPS.</p>
        <p class="dform-note"><b>Try this:</b> turn on GPS/Location Services, step outdoors or near a window, and make sure your browser has "Precise Location" enabled — then try again.</p>
        <button class="btn btn-primary" style="margin-top:10px" data-action="check-location">Try Again</button>
      </div>`;
  }

  function tooFarStepHTML() {
    const dist = deliveryLocation ? deliveryLocation.distanceKm.toFixed(2) : "?";
    const acc = deliveryLocation && deliveryLocation.accuracy != null ? Math.round(deliveryLocation.accuracy) : null;
    return `
      <button class="drawer-back" data-action="back-to-details">← Back</button>
      <div class="drawer-empty">
        <div class="drawer-empty-icon">😔</div>
        <p class="too-far-msg">Sorry! Home delivery is currently available only within ${CONFIG.DELIVERY_RADIUS_KM} KM of our restaurant.</p>
        <p class="dform-note">You're about ${dist} KM away${acc ? ` (accurate to ±${acc}m)` : ""}. You're welcome to call us to arrange pickup or delivery some other way.</p>
        <a class="btn btn-outline" href="tel:${CONFIG.PHONE_1}" style="display:block; text-align:center;">Call ${CONFIG.PHONE_1}</a>
        <button class="btn btn-primary" style="margin-top:10px" data-action="check-location">Try Again</button>
      </div>`;
  }

  function reviewStepHTML() {
    const d = window.__wvgwDraft || {};
    const lines = Object.values(cart);
    const rows = lines.map((l) => `
      <div class="review-line"><span>${l.qty} × ${l.name} (${l.variant})</span><span>₹${l.qty * l.price}</span></div>
    `).join("");
    const dist = deliveryLocation ? deliveryLocation.distanceKm.toFixed(2) : "—";
    const acc = deliveryLocation && deliveryLocation.accuracy != null ? Math.round(deliveryLocation.accuracy) : null;
    return `
      <button class="drawer-back" data-action="back-to-details">← Back</button>
      <h3 class="drawer-h">Review Your Order</h3>
      <div class="review-block">
        <div class="review-block-title">Items</div>
        ${rows}
        <div class="review-line review-total"><span>Total</span><span>₹${cartTotal()}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">Deliver To</div>
        <div class="review-detail"><b>${d.name}</b></div>
        <div class="review-detail">${d.phone}</div>
        <div class="review-detail">${d.address}${d.landmark ? " (Landmark: " + d.landmark + ")" : ""}</div>
        <div class="review-detail review-distance">✓ ${dist} KM from restaurant — within delivery zone${acc ? ` (±${acc}m accuracy)` : ""}</div>
      </div>
      <button class="btn btn-primary drawer-cta" data-action="place-order">Place Order</button>`;
  }

  function doneStepHTML() {
    const o = window.__wvgwLastOrder;
    if (!o) return `<div class="drawer-empty"><p>Order not found.</p></div>`;
    const rows = o.items.map((l) => `
      <div class="review-line"><span>${l.qty} × ${l.name} (${l.variant})</span><span>₹${l.qty * l.price}</span></div>
    `).join("");
    return `
      <div class="order-success">
        <div class="order-success-icon">✅</div>
        <h3 class="drawer-h" style="text-align:center">Order Placed Successfully!</h3>
        <div class="order-number">Order #${o.orderNumber}</div>
      </div>
      <div class="review-block">
        ${rows}
        <div class="review-line review-total"><span>Total</span><span>₹${o.total}</span></div>
      </div>
      <div class="review-block">
        <div class="review-detail"><b>${o.name}</b> · ${o.phone}</div>
        <div class="review-detail">${o.address}${o.landmark ? " (Landmark: " + o.landmark + ")" : ""}</div>
        <div class="review-detail">${o.placedAt}</div>
        <div class="review-detail">Status: <b>${o.status}</b></div>
      </div>
      <a class="btn btn-primary drawer-cta" id="whatsapp-send" href="${o.whatsappUrl}" target="_blank" rel="noopener">✅ Send Order to Restaurant via WhatsApp</a>
      <button class="btn btn-outline drawer-cta" data-action="close-drawer" style="margin-top:10px">Done</button>`;
  }

  /* ---------------------------------------------------------- step transitions & events */
  function wireStepEvents() {
    $$("[data-action]", $("#drawer-body")).forEach((el) => {
      el.addEventListener("click", handleAction);
    });
  }

  function handleAction(e) {
    const action = e.currentTarget.dataset.action;
    const key = e.currentTarget.dataset.key;

    if (action === "inc") { const l = cart[key]; addToCart(key, l.name, l.variant, l.price); renderDrawer(); }
    else if (action === "dec") { decFromCart(key); renderDrawer(); }
    else if (action === "browse-menu") { closeDrawer(); document.querySelector("#menu")?.scrollIntoView({ behavior: "smooth" }); }
    else if (action === "go-details") { step = "details"; renderDrawer(); }
    else if (action === "back-to-cart") { step = "cart"; renderDrawer(); }
    else if (action === "back-to-details") { step = "details"; renderDrawer(); }
    else if (action === "check-location") { validateAndLocate(); }
    else if (action === "place-order") { placeOrder(); }
    else if (action === "close-drawer") { cart = {}; saveCart(); renderAll(); closeDrawer(); }
  }

  function validateAndLocate() {
    const name = $("#d-name")?.value || "";
    const phone = $("#d-phone")?.value || "";
    const address = $("#d-address")?.value || "";
    const landmark = $("#d-landmark")?.value || "";

    let ok = true;
    setErr("err-name", "");
    setErr("err-phone", "");
    setErr("err-address", "");

    if (!validName(name)) { setErr("err-name", "Please enter your full name."); ok = false; }
    if (!validIndianPhone(phone)) { setErr("err-phone", "Enter a valid 10-digit Indian mobile number."); ok = false; }
    if (!validAddress(address)) { setErr("err-address", "Please enter your complete delivery address."); ok = false; }
    if (!ok) return;

    window.__wvgwDraft = { name: name.trim(), phone: normalizePhone(phone), address: address.trim(), landmark: landmark.trim() };

    if (!navigator.geolocation) {
      alert("Your browser doesn't support location detection, which we need to confirm you're within our delivery zone. Please try on a phone or a browser with location support.");
      return;
    }

    step = "locating";
    renderDrawer();

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy; // meters, per browser's own confidence radius
        const dist = distanceKm(CONFIG.RESTAURANT_LAT, CONFIG.RESTAURANT_LNG, lat, lng);
        deliveryLocation = { lat, lng, distanceKm: dist, accuracy };

        // If the browser itself says its fix could be off by more than 1km,
        // the 2km check isn't trustworthy either way — don't act on it, ask
        // for a better reading instead (this is the #1 real-world cause of
        // "wrong" distances: WiFi/IP-based positioning instead of true GPS,
        // common on laptops or with "approximate location" permissions).
        if (accuracy != null && accuracy > 1000) {
          step = "low-accuracy";
        } else if (dist <= CONFIG.DELIVERY_RADIUS_KM) {
          step = "review";
        } else {
          step = "too-far";
        }
        renderDrawer();
      },
      (err) => {
        step = "details";
        renderDrawer();
        const msg =
          err && err.code === 1
            ? "Location access was denied. Please allow location access in your browser's site settings, then try again — this is required before we can confirm your delivery."
            : "We couldn't get a clear location fix. Please make sure GPS/location is turned on and try again, ideally outdoors or near a window.";
        alert(msg);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function setErr(id, msg) {
    const el = document.getElementById(id);
    if (el) el.textContent = msg;
  }

  function placeOrder() {
    const d = window.__wvgwDraft || {};
    const items = Object.values(cart);
    const total = cartTotal();
    const orderNumber = "WVGW" + Date.now().toString().slice(-6) + Math.floor(10 + Math.random() * 90);
    const placedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

    const waLines = [
      `*New Home Delivery Order* — #${orderNumber}`,
      ``,
      ...items.map((l) => `${l.qty} × ${l.name} (${l.variant}) — ₹${l.qty * l.price}`),
      ``,
      `*Total: ₹${total}*`,
      ``,
      `Name: ${d.name}`,
      `Phone: ${d.phone}`,
      `Address: ${d.address}${d.landmark ? " (Landmark: " + d.landmark + ")" : ""}`,
      `Distance: ${deliveryLocation ? deliveryLocation.distanceKm.toFixed(2) : "—"} KM from restaurant${deliveryLocation && deliveryLocation.accuracy != null ? ` (±${Math.round(deliveryLocation.accuracy)}m accuracy)` : ""}`,
      `Placed: ${placedAt}`,
    ];
    const waNumber = (CONFIG.WHATSAPP_ORDER_NUMBER || CONFIG.PHONE_1 || "").replace(/\D/g, "");
    const whatsappUrl = `https://wa.me/91${waNumber}?text=${encodeURIComponent(waLines.join("\n"))}`;

    const order = {
      orderNumber,
      items,
      total,
      name: d.name,
      phone: d.phone,
      address: d.address,
      landmark: d.landmark,
      distanceKm: deliveryLocation ? Number(deliveryLocation.distanceKm.toFixed(2)) : null,
      locationAccuracyM: deliveryLocation && deliveryLocation.accuracy != null ? Math.round(deliveryLocation.accuracy) : null,
      placedAt,
      placedAtISO: new Date().toISOString(),
      status: "New",
      whatsappUrl,
    };

    saveOrder(order);
    window.__wvgwLastOrder = order;
    step = "done";
    renderDrawer();
  }

  function saveOrder(order) {
    try {
      const raw = localStorage.getItem(ORDERS_KEY);
      const orders = raw ? JSON.parse(raw) : [];
      orders.unshift(order);
      localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
    } catch (e) {}
  }

  /* ---------------------------------------------------------- add-to-cart button wiring (event delegation) */
  function initCartDelegation() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".ctrl-add, .ctrl-btn");
      if (!btn) return;
      const wrap = btn.closest("[data-cart-key]");
      if (!wrap) return;
      const key = wrap.dataset.cartKey;

      if (btn.classList.contains("ctrl-add")) {
        addToCart(key, wrap.dataset.name, wrap.dataset.variant, Number(wrap.dataset.price));
      } else if (btn.dataset.dir === "inc") {
        const l = cart[key];
        addToCart(key, l.name, l.variant, l.price);
      } else if (btn.dataset.dir === "dec") {
        decFromCart(key);
      }
    });
  }

  function initFab() {
    $("#delivery-fab")?.addEventListener("click", () => openDrawer());
    $("#delivery-backdrop")?.addEventListener("click", closeDrawer);
    $("#drawer-close")?.addEventListener("click", closeDrawer);
    $$('[data-open-delivery]').forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); openDrawer(); }));
  }

  document.addEventListener("DOMContentLoaded", () => {
    initCartDelegation();
    initFab();
    renderAll();
  });

  // exposed for debugging / potential future use
  window.WVGWCart = { addToCart, cart: () => cart };
})();
