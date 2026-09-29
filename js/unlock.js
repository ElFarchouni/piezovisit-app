/* PiezoVisit - password screen of the PROTECTED (hosted) version.
   The piezometer data, the visits and the routes are stored encrypted (AES-256-GCM, key derived
   from the password with PBKDF2). Without the password the site shows nothing but this screen.
   After a first success the key is remembered on the device, so the app also opens offline. */
(function () {
  "use strict";

  const ENC = window.PIEZO_ENC;
  const APP_SCRIPTS = ["js/i18n.js", "js/core.js", "js/app.js"];
  const KEY_NAME = "piezovisit.key";
  const fr = (navigator.language || "").toLowerCase().startsWith("fr");
  const T = fr ? {
    text: "Saisissez le mot de passe de l'équipe pour ouvrir l'appli.",
    pw: "Mot de passe", open: "Ouvrir", wait: "Vérification...", bad: "Mot de passe incorrect.",
    noCrypto: "Ce navigateur ne peut pas ouvrir la version protégée. Utilisez un Chrome, Edge, Firefox ou Safari récent, sur l'adresse https.",
    keep: "Rester connecté sur cet appareil",
  } : {
    text: "Enter the team password to open the app.",
    pw: "Password", open: "Open", wait: "Checking...", bad: "Wrong password.",
    noCrypto: "This browser cannot open the protected version. Use a recent Chrome, Edge, Firefox or Safari, on the https address.",
    keep: "Stay signed in on this device",
  };

  const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const text64 = buf => { let s = ""; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
  const stored = () => { try { return localStorage.getItem(KEY_NAME); } catch (e) { return null; } };
  const remember = v => {
    try { if (v) localStorage.setItem(KEY_NAME, v); else localStorage.removeItem(KEY_NAME); }
    catch (e) { /* private browsing: the password is asked every time */ }
  };

  async function keyFromPassword(password) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes(ENC.salt), iterations: ENC.iter, hash: "SHA-256" }, base, 256);
  }
  async function decrypt(rawKey) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(ENC.iv) }, key, bytes(ENC.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function startApp(data) {
    window.PIEZO_NETWORK = data.network;
    window.PIEZO_VISITS = data.visits;
    window.PIEZO_ROUTES = data.routes;
    const screen = document.getElementById("lock");
    if (screen) screen.remove();
    document.body.classList.remove("locked");
    APP_SCRIPTS.reduce((p, src) => p.then(() => new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = fail;
      document.body.appendChild(s);
    })), Promise.resolve());
  }

  function showScreen(message) {
    document.body.classList.add("locked");
    const el = document.createElement("div");
    el.id = "lock";
    el.className = "lock";
    el.innerHTML = '<form class="lock-card" autocomplete="off">' +
      '<img src="icons/icon.svg" width="64" height="64" alt="">' +
      "<h1>PiezoVisit</h1><p>" + (message || T.text) + "</p>" +
      (message ? "" :
        '<label class="field"><span>' + T.pw + '</span><input type="password" name="pw" autocomplete="current-password" required></label>' +
        '<label class="check"><input type="checkbox" name="keep" checked><span>' + T.keep + "</span></label>" +
        '<div class="warn" hidden></div>' +
        '<button type="submit" class="btn primary">' + T.open + "</button>") +
      "</form>";
    document.body.appendChild(el);
    if (message) return;
    const form = el.querySelector("form");
    form.elements.pw.focus();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = form.querySelector("button");
      const warn = form.querySelector(".warn");
      btn.disabled = true; btn.textContent = T.wait; warn.hidden = true;
      try {
        const raw = await keyFromPassword(form.elements.pw.value);
        const data = await decrypt(raw);
        if (form.elements.keep.checked) remember(text64(raw));
        startApp(data);
      } catch (err) {
        warn.textContent = T.bad; warn.hidden = false;
        btn.disabled = false; btn.textContent = T.open;
        form.elements.pw.select();
      }
    });
  }

  async function main() {
    if (!ENC || !window.crypto || !crypto.subtle) { showScreen(T.noCrypto); return; }
    const saved = stored();
    if (saved) {
      try { startApp(await decrypt(bytes(saved))); return; }
      catch (e) { remember(null); }        // the password was changed at the office
    }
    showScreen();
  }
  main();
})();
