// Plain browser JavaScript. No framework, bundler, CDN, or third-party scripts.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const page = document.body.dataset.page;
let csrfToken = null;
let currentUser = null;

async function api(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers:
      method === "GET"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken ?? "",
          },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error || "Unable to reach the server. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function link(text, href, className = "") {
  const element = node("a", className, text);
  element.href = href;
  return element;
}
function message(element, text, success = false) {
  element.hidden = !text;
  element.textContent = text;
  element.classList.toggle("success", success);
}
async function submit(form, action, errorTarget = $("#form-message")) {
  const button = $("[type=submit]", form);
  button.disabled = true;
  if (errorTarget) message(errorTarget, "");
  try {
    await action();
  } catch (error) {
    if (errorTarget) message(errorTarget, error.message);
  } finally {
    button.disabled = false;
  }
}
const params = new URLSearchParams(location.search);
// Never redirect to a user-supplied URL: only these fixed destinations are allowed.
const nextPage =
  params.get("next") === "book" ? "/book.html" : "/reservations.html";

$("#menu-toggle").addEventListener("click", () => {
  const button = $("#menu-toggle");
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  $("#main-nav").classList.toggle("open", open);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#main-nav").classList.contains("open")) {
    $("#main-nav").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
    $("#menu-toggle").focus();
  }
});
for (const item of $$("#main-nav a"))
  if (new URL(item.href).pathname === location.pathname)
    item.setAttribute("aria-current", "page");
const cookieNote = $("#cookie-note");
try {
  cookieNote.hidden = localStorage.getItem("jd_cookie_notice") === "dismissed";
} catch {
  cookieNote.hidden = false;
}
$("#cookie-dismiss").addEventListener("click", () => {
  try {
    localStorage.setItem("jd_cookie_notice", "dismissed");
  } catch {
    /* Storage is optional. */
  }
  cookieNote.hidden = true;
});
$("#cookie-settings").addEventListener("click", () => {
  cookieNote.hidden = false;
  $("#cookie-dismiss").focus();
});

function showSignIn(
  target,
  text = "Please sign in to see your pretend reservations.",
) {
  target.replaceChildren(
    node("p", "", text),
    link("Sign in", "/login.html", "button"),
    document.createTextNode(" "),
    link("Create an account", "/register.html", "under-link"),
  );
}
function updateNavigation() {
  if (currentUser) {
    const item = $("#account-link");
    item.textContent = "My account";
    item.href = "/account.html";
    if (page === "account") item.setAttribute("aria-current", "page");
  }
}
async function initialize() {
  try {
    const needsSession = [
      "login",
      "register",
      "book",
      "reservations",
      "account",
    ].includes(page);
    const data = await api(needsSession ? "/session" : "/session?passive=1");
    currentUser = data.user;
    csrfToken = data.csrfToken;
    updateNavigation();
    if (page === "login" || page === "register") initAuth();
    if (page === "book") initBooking();
    if (page === "reservations") await initReservations();
    if (page === "account") initAccount();
    if (page === "privacy") await initPrivacy();
  } catch (error) {
    const target =
      $("#form-message") ||
      $("#booking-loading") ||
      $("#reservations-message") ||
      $("#account-message");
    if (target) {
      target.hidden = false;
      target.replaceChildren(
        node("span", "", `Could not load your session: ${error.message} `),
        link("Reload this page", location.pathname + location.search),
      );
      $$("form [type=submit]").forEach((button) => {
        button.disabled = true;
      });
    }
    // Informational pages remain readable if the API is temporarily unavailable.
  }
}

function initAuth() {
  if (currentUser) {
    location.replace(nextPage);
    return;
  }
  const otherLink = page === "login" ? $("#register-link") : $("#login-link");
  if (params.get("next") === "book") otherLink.href += "?next=book";
  const form = $(`#${page}-form`);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(form, async () => {
      const fields = new FormData(form);
      const body = {
        email: fields.get("email"),
        password: fields.get("password"),
      };
      if (page === "register") {
        body.name = fields.get("name");
        body.parodyAcknowledged = fields.get("parody") === "on";
      }
      await api(`/${page}`, { method: "POST", body });
      location.assign(nextPage);
    });
  });
  $("[type=submit]", form).disabled = false;
}

function initBooking() {
  $("#booking-loading").hidden = true;
  if (!currentUser) {
    $("#booking-auth").hidden = false;
    return;
  }
  const form = $("#booking-form");
  form.hidden = false;
  const experience = $("#experience");
  const selected = params.get("experience");
  if ([...experience.options].some((option) => option.value === selected))
    experience.value = selected;
  const dateInput = $("#date"),
    guestsInput = $("#guests"),
    slots = $("#time-slots"),
    availabilityMessage = $("#availability-message");
  const tomorrow = new Date();
  tomorrow.setUTCHours(0, 0, 0, 0);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  dateInput.min = tomorrow.toISOString().slice(0, 10);
  dateInput.max = new Date(tomorrow.getTime() + 29 * 86400000)
    .toISOString()
    .slice(0, 10);
  let generation = 0;
  let controller;
  async function refreshSlots() {
    const ticket = ++generation;
    controller?.abort();
    controller = new AbortController();
    slots.replaceChildren();
    if (!dateInput.value) {
      availabilityMessage.textContent = "Choose a date to see availability.";
      return;
    }
    availabilityMessage.textContent = "Checking pretend seats…";
    try {
      const data = await api(
        `/availability?date=${encodeURIComponent(dateInput.value)}`,
        { signal: controller.signal },
      );
      if (ticket !== generation) return;
      let available = 0;
      for (const slot of data.slots) {
        const label = node("label", "time-option");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "time";
        radio.value = slot.time;
        radio.required = true;
        radio.disabled = slot.remaining < Number(guestsInput.value);
        if (!radio.disabled) available++;
        const text = node("span", "", `${slot.time} UTC`);
        text.append(node("small", "", `${slot.remaining} pretend seats left`));
        label.append(radio, text);
        slots.append(label);
      }
      availabilityMessage.textContent = available
        ? "Six seats per time, shared across all experiences."
        : "No times fit this party size. Try another date or fewer guests.";
    } catch (error) {
      if (error.name !== "AbortError" && ticket === generation)
        availabilityMessage.textContent = error.message;
    }
  }
  dateInput.addEventListener("change", refreshSlots);
  guestsInput.addEventListener("change", refreshSlots);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(form, async () => {
      const fields = new FormData(form);
      if (!fields.get("time"))
        throw new Error("Please choose an available time.");
      try {
        await api("/reservations", {
          method: "POST",
          body: {
            experienceId: fields.get("experience"),
            date: fields.get("date"),
            guests: Number(fields.get("guests")),
            time: fields.get("time"),
            parodyAcknowledged: fields.get("parody") === "on",
          },
        });
        location.assign("/reservations.html?booked=1");
      } catch (error) {
        if (error.status === 409) await refreshSlots();
        throw error;
      }
    });
  });
  $("[type=submit]", form).disabled = false;
}

async function initReservations() {
  const status = $("#reservations-message"),
    list = $("#reservations-list");
  if (!currentUser) {
    showSignIn(status);
    return;
  }
  const [bookings, catalog] = await Promise.all([
    api("/reservations"),
    api("/experiences"),
  ]);
  let reservations = bookings.reservations;
  const experiences = new Map(
    catalog.experiences.map((item) => [item.id, item]),
  );
  let filter = "upcoming";
  let pendingId = null;
  const dialog = $("#cancel-dialog");
  function render() {
    list.replaceChildren();
    const now = Date.now();
    const rows = reservations.filter(
      (item) =>
        filter === "all" ||
        (filter === "cancelled"
          ? item.status === "cancelled"
          : item.status === "confirmed" &&
            new Date(`${item.day}T${item.time}:00Z`).getTime() >= now),
    );
    status.textContent =
      params.get("booked") === "1"
        ? "Pretend reservation saved! No real appointment has been made. You can view or cancel it below."
        : `${rows.length} ${filter === "all" ? "" : filter + " "}pretend reservation${rows.length === 1 ? "" : "s"}.`;
    if (!rows.length) {
      const empty = node("div", "empty-state");
      empty.append(
        node("h3", "", "Nothing on the imaginary horizon."),
        node(
          "p",
          "",
          "Pick a peculiar experience and give your calendar something to laugh about.",
        ),
        link("Explore experiences ↗", "/experiences.html", "button"),
      );
      list.append(empty);
      return;
    }
    for (const item of rows) {
      const experience = experiences.get(item.experience_id);
      const row = node("article", "reservation-row");
      const image = document.createElement("img");
      image.src = `/assets/${experience?.art ?? "buffet"}.svg`;
      image.alt = "";
      image.width = 95;
      image.height = 80;
      const main = node("div");
      const past = new Date(`${item.day}T${item.time}:00Z`).getTime() < now;
      main.append(
        node(
          "span",
          `status ${item.status === "cancelled" ? "cancelled" : ""}`,
          item.status === "cancelled"
            ? "CANCELLED"
            : past
              ? "PAST · PRETEND"
              : "CONFIRMED · PRETEND",
        ),
        node("h3", "", experience?.name ?? "Fictional experience"),
        node("p", "reference", `Ref: ${item.id.slice(0, 8).toUpperCase()}`),
      );
      const date = new Date(`${item.day}T00:00:00Z`).toLocaleDateString(
        undefined,
        { dateStyle: "medium", timeZone: "UTC" },
      );
      const details = node("div");
      details.append(
        node("p", "", date),
        node(
          "p",
          "",
          `${item.time} UTC · ${item.guests} guest${item.guests === 1 ? "" : "s"}`,
        ),
        node("p", "reference", "No real services or charges."),
      );
      row.append(image, main, details);
      if (item.status === "confirmed") {
        const cancel = node(
          "button",
          "button secondary small",
          "Cancel reservation",
        );
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          pendingId = item.id;
          $("#cancel-message").textContent = "";
          dialog.showModal();
        });
        row.append(cancel);
      }
      list.append(row);
    }
  }
  for (const tab of $$("[data-filter]"))
    tab.addEventListener("click", () => {
      filter = tab.dataset.filter;
      for (const other of $$("[data-filter]")) {
        other.classList.toggle("active", other === tab);
        other.setAttribute("aria-pressed", String(other === tab));
      }
      render();
    });
  $("#keep-booking").addEventListener("click", () => dialog.close());
  $("#confirm-cancel").addEventListener("click", async () => {
    const button = $("#confirm-cancel");
    button.disabled = true;
    try {
      await api(`/reservations/${pendingId}/cancel`, {
        method: "POST",
        body: {},
      });
      reservations = reservations.map((item) =>
        item.id === pendingId ? { ...item, status: "cancelled" } : item,
      );
      dialog.close();
      render();
      // The row button may have been removed; restore focus to a stable control.
      $(`[data-filter="${filter}"]`).focus();
    } catch (error) {
      $("#cancel-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  render();
}

function initAccount() {
  if (!currentUser) {
    showSignIn($("#account-message"), "Please sign in to manage your account.");
    return;
  }
  $("#account-message").textContent =
    "A real account for a very imaginary place.";
  const details = $("#account-details");
  for (const [label, value] of [
    ["Nickname", currentUser.name],
    ["Email address", currentUser.email],
  ])
    details.append(node("dt", "", label), node("dd", "", value));
  $("#account-actions").hidden = false;
  $("#delete-panel").hidden = false;
  $("#logout").addEventListener("click", async () => {
    const button = $("#logout");
    button.disabled = true;
    try {
      await api("/logout", { method: "POST", body: {} });
      location.assign("/");
    } catch (error) {
      $("#account-message").textContent = error.message;
      button.disabled = false;
    }
  });
  $("#delete-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit(
      event.currentTarget,
      async () => {
        await api("/account", {
          method: "DELETE",
          body: { password: $("#delete-password").value },
        });
        location.assign("/");
      },
      $("#delete-message"),
    );
  });
  $("#delete-form [type=submit]").disabled = false;
}
async function initPrivacy() {
  const data = await api("/site");
  if (data.operatorName && data.privacyEmail) {
    const element = $("#operator-contact");
    element.replaceChildren(
      document.createTextNode(
        `Operated by ${data.operatorName}. For privacy requests, contact `,
      ),
      link(data.privacyEmail, `mailto:${data.privacyEmail}`),
      document.createTextNode("."),
    );
  }
}
await initialize();
