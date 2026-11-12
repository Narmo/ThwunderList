var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
  "resource:///modules/gloda/MimeMessage.sys.mjs"
);
var { JSONFile } = ChromeUtils.importESModule("resource://gre/modules/JSONFile.sys.mjs");

const AVATAR_PREF = "extensions.thwunderlist.showAvatars";
const ACCOUNT_COLORS_PREF = "extensions.thwunderlist.showAccountColors";
const REMOTE_AVATAR_PREF = "extensions.thwunderlist.remoteAvatars";
// shortcut: common personal-mail domains only; extend when another provider is reported.
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk",
  "live.com", "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com",
  "fastmail.com", "hey.com", "tuta.com", "tutanota.com", "yandex.ru",
  "yandex.com", "ya.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "qq.com", "163.com",
]);
const PREVIEW_LINES_PREF = "extensions.thwunderlist.previewLines";
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]*$/iu;

function avatarStorePath() {
  const file = Services.dirsvc.get("ProfLD", Ci.nsIFile);
  file.append("thwunderlist-avatars.json");
  return file.path;
}

// Returns the ASCII host of an address under a public suffix, or null.
function asciiDomain(address) {
  const email = address?.trim().toLowerCase();
  const match = email?.match(/^[^\s@]+@([^\s@]+)$/u);
  if (!match || email.length > 254) {
    return null;
  }
  try {
    const domain = Cc["@mozilla.org/network/idn-service;1"]
      .getService(Ci.nsIIDNService).convertUTF8toACE(match[1]);
    // Internal names such as corp.internal must never reach a third party.
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(domain) &&
      Services.eTLD.hasKnownPublicSuffixFromHost(domain) ? domain : null;
  } catch {
    return null;
  }
}

// True when one RFC 8601 Authentication-Results field shows that `domain`
// passed DMARC, or passed DKIM with relaxed alignment.
function senderAuthenticated(field, domain) {
  // Quoted strings can carry sender-chosen ";" and "=", and comments can carry ";".
  let value = field.replace(/^[^:]*:/u, "").replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  for (let previous; previous !== value;) {
    previous = value;
    value = value.replace(/\([^()]*\)/gu, " ");
  }
  const organization = host => {
    try {
      return Services.eTLD.getBaseDomainFromHost(host);
    } catch {
      return null;
    }
  };
  let verified = false;
  for (const result of value.toLowerCase().split(";")) {
    const [, method, outcome] = result.match(/^\s*(dkim|dmarc)\s*=\s*([a-z]+)/u) ?? [];
    const property = name => result.match(new RegExp(`\\bheader\\.${name}\\s*=\\s*([^\\s;]+)`, "u"))?.[1];
    if (method === "dmarc") {
      if (outcome !== "pass" || property("from") !== domain) {
        return false;
      }
      verified = true;
    } else if (method === "dkim" && outcome === "pass") {
      const signer = property("d") ?? property("i")?.split("@").pop();
      const own = organization(domain);
      verified ||= Boolean(own && signer && organization(signer) === own);
    }
  }
  return verified;
}

// Reads the header block of a locally stored message; nothing is downloaded.
function readHeaderBlock(header) {
  return new Promise(resolve => {
    if (!["none", "pop3"].includes(header.folder.server.type) &&
        !(header.flags & Ci.nsMsgMessageFlags.Offline)) {
      resolve("");
      return;
    }
    let text = "";
    let stream;
    let done = false;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onDataAvailable(request, input, _offset, count) {
        if (!stream) {
          stream = Cc["@mozilla.org/scriptableinputstream;1"]
            .createInstance(Ci.nsIScriptableInputStream);
          stream.init(input);
        }
        const chunk = stream.read(count);
        if (done) {
          return;
        }
        text += chunk;
        const end = text.search(/\r?\n\r?\n/u);
        if (end >= 0 || text.length > 64 * 1024) {
          text = end >= 0 ? text.slice(0, end) : text;
          done = true;
          try {
            request.cancel(Cr.NS_BINDING_ABORTED);
          } catch {
            // The body is ignored either way.
          }
        }
      },
      onStopRequest() {
        resolve(text);
      },
    };
    try {
      const uri = header.folder.getUriForMsg(header);
      MailServices.messageServiceFromURI(uri)
        .streamMessage(uri, listener, null, null, false, "", true);
    } catch {
      resolve("");
    }
  });
}

async function isAuthenticatedSender(header, address) {
  const domain = asciiDomain(address);
  const block = domain ? await readHeaderBlock(header) : "";
  // Only the receiving server's own verdict counts: it is prepended above any
  // copy a sender wrote into the message.
  const field = block.replace(/\r?\n[ \t]+/gu, " ").split(/\r?\n/u)
    .find(line => /^authentication-results\s*:/iu.test(line));
  return Boolean(field) && senderAuthenticated(field, domain);
}

this.mailList = class extends ExtensionCommon.ExtensionAPI {
  avatarCache = new Map();
  // Per-message outcomes, so recycled rows redraw without re-checking headers.
  messageAvatars = new Map();
  avatarRequests = new Set();

  getAPI(context) {
    return {
      mailList: {
        start: () => this.start(context.extension),
        getShowAvatars: async () => Services.prefs.getBoolPref(AVATAR_PREF, true),
        setShowAvatars: async showAvatars => this.setShowAvatars(showAvatars),
        getShowAccountColors: async () => Services.prefs.getBoolPref(ACCOUNT_COLORS_PREF, true),
        setShowAccountColors: async showAccountColors => this.setShowAccountColors(showAccountColors),
        getRemoteAvatars: async () => Services.prefs.getBoolPref(REMOTE_AVATAR_PREF, false),
        setRemoteAvatars: async enabled => {
          Services.prefs.setBoolPref(REMOTE_AVATAR_PREF, enabled);
          this.resetRemoteAvatars();
          if (!enabled) {
            this.wipeAvatarStore();
          }
          for (const window of this.panes?.keys() ?? []) {
            window.threadTree.invalidate();
          }
        },
        getPreviewLines: async () => Services.prefs.getIntPref(PREVIEW_LINES_PREF, 2),
        setPreviewLines: async previewLines => {
          Services.prefs.setIntPref(PREVIEW_LINES_PREF, previewLines);
          await Promise.all(
            [...(this.panes?.keys() ?? [])].map(window => window.threadPane.updateThreadItemSize())
          );
        },
        onShowAvatarsChanged: new ExtensionCommon.EventManager({
          context,
          name: "mailList.onShowAvatarsChanged",
          register: fire => {
            const observer = {
              observe: () => fire.async(Services.prefs.getBoolPref(AVATAR_PREF, true)),
            };
            Services.prefs.addObserver(AVATAR_PREF, observer);
            return () => Services.prefs.removeObserver(AVATAR_PREF, observer);
          },
        }).api(),
        onShowAccountColorsChanged: new ExtensionCommon.EventManager({
          context,
          name: "mailList.onShowAccountColorsChanged",
          register: fire => {
            const observer = {
              observe: () => fire.async(Services.prefs.getBoolPref(ACCOUNT_COLORS_PREF, true)),
            };
            Services.prefs.addObserver(ACCOUNT_COLORS_PREF, observer);
            return () => Services.prefs.removeObserver(ACCOUNT_COLORS_PREF, observer);
          },
        }).api(),
        onRemoteAvatarsChanged: new ExtensionCommon.EventManager({
          context,
          name: "mailList.onRemoteAvatarsChanged",
          register: fire => {
            const observer = {
              observe: () => fire.async(Services.prefs.getBoolPref(REMOTE_AVATAR_PREF, false)),
            };
            Services.prefs.addObserver(REMOTE_AVATAR_PREF, observer);
            return () => Services.prefs.removeObserver(REMOTE_AVATAR_PREF, observer);
          },
        }).api(),
      },
    };
  }

  // Fetched images and misses, kept across restarts in the profile's cache directory.
  async avatarStore() {
    await this.avatarWipe;
    const file = this.avatarFile ??= new JSONFile({
      path: avatarStorePath(),
      dataPostProcessor: data => {
        // The file lives outside the add-on; keep only unexpired, well-formed images.
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return {};
        }
        for (const [url, entry] of Object.entries(data)) {
          if (!(entry?.expires > Date.now()) || !(entry.data === null || IMAGE_DATA.test(entry.data))) {
            delete data[url];
          }
        }
        return data;
      },
    });
    await file.load();
    return file === this.avatarFile ? file.data : null;
  }

  wipeAvatarStore() {
    const file = this.avatarFile;
    this.avatarFile = null;
    if (file) {
      // A save already armed then writes nothing.
      file.data = {};
    }
    this.avatarWipe = Promise.allSettled([file?.finalize(), IOUtils.remove(avatarStorePath())]);
  }

  resetRemoteAvatars() {
    this.avatarCache = new Map();
    this.messageAvatars = new Map();
    for (const controller of this.avatarRequests) {
      controller.abort();
    }
    this.avatarRequests.clear();
  }

  async getRemoteAvatar(window, address, isCurrent) {
    const email = address?.trim().toLowerCase();
    let domain = asciiDomain(email);
    if (!domain) {
      return null;
    }
    try {
      domain = Services.eTLD.getBaseDomainFromHost(domain);
    } catch {
      return null;
    }
    const cache = this.avatarCache;
    const digest = await window.crypto.subtle.digest("SHA-256", new window.TextEncoder().encode(email));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const sources = [{ url: `https://gravatar.com/avatar/${hash}?s=160&d=404&r=g`, logo: false }];
    if (!PERSONAL_MAIL_DOMAINS.has(domain)) {
      sources.push({ url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`, logo: true });
    }
    for (const { url, logo } of sources) {
      if (!isCurrent() || cache !== this.avatarCache || Services.io.offline ||
          !Services.prefs.getBoolPref(AVATAR_PREF, true) ||
          !Services.prefs.getBoolPref(REMOTE_AVATAR_PREF, false)) {
        return null;
      }
      const photo = await this.fetchRemoteImage(window, url);
      if (photo && cache === this.avatarCache) {
        return { src: photo, logo };
      }
    }
    return null;
  }

  fetchRemoteImage(window, url) {
    // The message pane's CSP forbids network requests; use its owning chrome window.
    window = window.top;
    const cache = this.avatarCache;
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) {
      return cached.promise;
    }
    const controller = new window.AbortController();
    this.avatarRequests.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 5000);
    let received = false;
    const promise = (async () => {
      try {
        const stored = (await this.avatarStore())?.[url];
        if (stored?.expires > Date.now()) {
          return stored.data;
        }
        const response = await window.fetch(url, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        received = true;
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(type || "")) {
          await response.body?.cancel();
          return null;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > 128 * 1024) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
        const data = await new Promise(resolve => {
          const fileReader = new window.FileReader();
          fileReader.onload = () => resolve(fileReader.result);
          fileReader.onerror = () => resolve(null);
          fileReader.readAsDataURL(new window.Blob(chunks, { type }));
        });
        if (!data) {
          return null;
        }
        const image = new window.Image();
        const loaded = new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
        });
        image.src = data;
        await loaded;
        // A tiny file can declare huge dimensions; check them before decoding pixels.
        // Icons under 32 px look worse upscaled than the initials they replace.
        if (Math.min(image.naturalWidth, image.naturalHeight) < 32 ||
            Math.max(image.naturalWidth, image.naturalHeight) > 512) {
          return null;
        }
        await image.decode();
        return data;
      } catch {
        // A missing image or network failure must leave the initials intact.
        return null;
      } finally {
        window.clearTimeout(timer);
        this.avatarRequests.delete(controller);
        if (controller.signal.aborted) {
          cache.delete(url);
        }
      }
    })();
    if (cache.size >= 256) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(url, { promise, expires: Date.now() + 30 * 60_000 });
    // Persist answers the provider gave, not timeouts or network failures.
    promise.then(data => {
      const store = this.avatarFile?.dataReady && this.avatarFile.data;
      if (!received || controller.signal.aborted || cache !== this.avatarCache || !store) {
        return;
      }
      delete store[url];
      const urls = Object.keys(store);
      if (urls.length >= 256) {
        delete store[urls[0]];
      }
      store[url] = { data, expires: Date.now() + (data ? 7 : 1) * 86_400_000 };
      this.avatarFile.saveSoon();
    });
    return promise;
  }

  setShowAvatars(showAvatars) {
    Services.prefs.setBoolPref(AVATAR_PREF, showAvatars);
    if (!showAvatars) {
      this.resetRemoteAvatars();
      this.wipeAvatarStore();
    }
    for (const window of this.panes?.keys() ?? []) {
      window.threadTree.toggleAttribute("data-thw-hide-avatars", !showAvatars);
      window.threadTree.invalidate();
    }
    for (const { item } of this.menus?.values() ?? []) {
      item.toggleAttribute("checked", showAvatars);
    }
  }

  setShowAccountColors(showAccountColors) {
    Services.prefs.setBoolPref(ACCOUNT_COLORS_PREF, showAccountColors);
    for (const window of this.panes?.keys() ?? []) {
      window.threadTree.toggleAttribute("data-thw-hide-account-colors", !showAccountColors);
    }
    for (const { accountColorsItem } of this.menus?.values() ?? []) {
      accountColorsItem.toggleAttribute("checked", showAccountColors);
    }
  }

  addViewMenu(window) {
    if (this.menus.has(window)) {
      return;
    }
    const anchor = window.document.getElementById("viewAttachmentsInlineMenuitem");
    if (!anchor) {
      return;
    }
    const item = window.document.createXULElement("menuitem");
    item.id = "thwunderlist-show-avatars";
    item.setAttribute("type", "checkbox");
    item.setAttribute("label", "Show sender avatars");
    item.toggleAttribute("checked", Services.prefs.getBoolPref(AVATAR_PREF, true));
    item.addEventListener("command", () => {
      this.setShowAvatars(!Services.prefs.getBoolPref(AVATAR_PREF, true));
    });
    anchor.after(item);
    const accountColorsItem = window.document.createXULElement("menuitem");
    accountColorsItem.id = "thwunderlist-show-account-colors";
    accountColorsItem.setAttribute("type", "checkbox");
    accountColorsItem.setAttribute("label", "Show account color indicators");
    accountColorsItem.toggleAttribute("checked", Services.prefs.getBoolPref(ACCOUNT_COLORS_PREF, true));
    accountColorsItem.addEventListener("command", () => {
      this.setShowAccountColors(!Services.prefs.getBoolPref(ACCOUNT_COLORS_PREF, true));
    });
    item.after(accountColorsItem);
    const cleanup = () => {
      item.remove();
      accountColorsItem.remove();
      window.removeEventListener("unload", cleanup);
      this.menus.delete(window);
    };
    this.menus.set(window, { item, accountColorsItem, cleanup });
    window.addEventListener("unload", cleanup, { once: true });
  }

  start(extension) {
    if (this.panes) {
      return;
    }
    this.panes = new Map();
    this.pending = new Map();
    this.menus = new Map();
    this.styleURI = Services.io.newURI(
      extension.rootURI.resolve("styles/mail-list.css")
    );
    this.observer = {
      observe: document => this.watch(document),
    };
    Services.obs.addObserver(this.observer, "chrome-document-loaded");
    for (const window of Services.wm.getEnumerator("mail:3pane")) {
      for (const browser of window.document.querySelectorAll("browser")) {
        if (browser.currentURI?.spec === "about:3pane") {
          this.watch(browser.contentDocument);
        }
      }
    }
  }

  watch(document) {
    if (document.documentURI !== "about:3pane") {
      return;
    }
    const window = document.defaultView;
    if (this.pending.has(window) || this.panes.has(window)) {
      return;
    }
    const load = async () => {
      try {
        await window.hasDOMContentLoaded?.promise;
        if (this.pending.has(window) && !window.closed) {
          this.attach(window);
        }
      } catch (error) {
        console.error("ThwunderList: could not style this mail tab", error);
      } finally {
        this.pending.delete(window);
      }
    };
    this.pending.set(window, load);
    if (document.readyState === "complete") {
      load();
    } else {
      window.addEventListener("load", load, { once: true });
    }
  }

  attach(window) {
    const { document, threadPane, threadTree } = window;
    const Card = window.customElements.get("thread-card");
    if (!Card || !threadPane || !threadTree) {
      throw new Error("Unsupported Thunderbird message-list structure.");
    }
    this.addViewMenu(window.top);
    const originalFill = Card.prototype.fillRow;
    const originalDensity = threadPane.densityChange;
    const originalHeight = Card.ROW_HEIGHT;
    const attempted = new Map();
    let previewTimer = 0;
    let fetchingPreviews = false;
    let fetchingAvatars = false;
    let active = true;

    const schedulePreviews = () => {
      if (!active || previewTimer) {
        return;
      }
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        fetchPreviews();
        fetchAvatars();
      }, 75);
    };

    const showPhoto = (avatar, { src, logo }, onError) => {
      const photo = document.createElement("img");
      photo.alt = "";
      photo.hidden = true;
      photo.decoding = "async";
      if (logo) {
        photo.classList.add("thw-logo");
      }
      photo.addEventListener("load", () => { photo.hidden = false; }, { once: true });
      photo.addEventListener("error", () => {
        if (photo.parentNode === avatar) {
          photo.remove();
          onError?.();
        }
      }, { once: true });
      avatar.append(photo);
      photo.src = src;
      // A cached image is ready at once; showing it now avoids an initials flash.
      if (photo.complete && photo.naturalWidth) {
        photo.hidden = false;
      }
    };

    const knownAvatar = key => {
      const known = this.messageAvatars.get(key);
      return known?.expires > Date.now() ? known : null;
    };

    const canFetchAvatars = () => active && !document.hidden && !Services.io.offline &&
      threadTree.getAttribute("rows") === "thread-card" &&
      !threadTree.hasAttribute("data-thw-hide-avatars") &&
      Services.prefs.getBoolPref(REMOTE_AVATAR_PREF, false);

    const fetchAvatars = async () => {
      if (fetchingAvatars || !canFetchAvatars()) {
        return;
      }
      for (let i = threadTree.getFirstVisibleIndex(); i <= threadTree.getLastVisibleIndex(); i++) {
        const row = threadTree.getRowAtIndex(i);
        const request = row?.thwAvatarRequest;
        if (!request?.email) {
          continue;
        }
        const isCurrent = () => canFetchAvatars() && row.isConnected &&
          row.thwAvatarRequest === request && row.index >= threadTree.getFirstVisibleIndex() &&
          row.index <= threadTree.getLastVisibleIndex();
        const known = this.messageAvatars;
        fetchingAvatars = true;
        try {
          // A forged From must not borrow a real person's photo or a brand's logo.
          const authenticated = !request.header ||
            await isAuthenticatedSender(request.header, request.email);
          const photo = authenticated
            ? await this.getRemoteAvatar(window, request.email, isCurrent)
            : null;
          if (isCurrent()) {
            row.thwAvatarRequest = null;
            if (known === this.messageAvatars) {
              if (known.size >= 512) {
                known.delete(known.keys().next().value);
              }
              known.set(request.key, { photo, expires: Date.now() + 30 * 60_000 });
            }
            if (photo) {
              showPhoto(row.querySelector(".thw-avatar"), photo);
            }
          }
        } catch {
          // A closing tab can invalidate its crypto and image APIs.
          if (row.thwAvatarRequest === request) {
            row.thwAvatarRequest = null;
          }
        } finally {
          fetchingAvatars = false;
        }
        // Stored results should not trickle in one timer tick per row.
        return fetchAvatars();
      }
    };

    const fetchPreviews = async () => {
      if (!active || fetchingPreviews || document.hidden ||
          threadTree.getAttribute("rows") !== "thread-card") {
        return;
      }
      const batch = [];
      const now = Date.now();
      for (let i = threadTree.getFirstVisibleIndex(); i <= threadTree.getLastVisibleIndex(); i++) {
        const row = threadTree.getRowAtIndex(i);
        if (!row?.thwMessage) {
          continue;
        }
        try {
          const header = row.view.getMsgHdrAt(i);
          const key = header.folder.URI + "#" + header.messageKey;
          if (row.thwMessage !== key) {
            continue;
          }
          const preview = row.querySelector(".thw-preview");
          preview.textContent = header.getStringProperty("preview").replace(/\s+/gu, " ").trim();
          const type = header.folder.server.type;
          const offline = Boolean(header.flags & Ci.nsMsgMessageFlags.Offline);
          const attemptKey = key + ":" + offline;
          if (preview.textContent || !["none", "pop3", "imap"].includes(type) ||
              (type === "imap" && Services.io.offline && !offline) ||
              now - (attempted.get(attemptKey) || 0) < 60_000 ||
              (batch.length && batch[0].header.folder.URI !== header.folder.URI)) {
            continue;
          }
          batch.push({ row, header, preview, key, attemptKey });
        } catch {
          // A folder switch or deletion can invalidate a buffered row.
        }
      }
      if (!batch.length) {
        return;
      }
      fetchingPreviews = true;
      for (const { attemptKey } of batch) {
        if (attempted.size >= 512) {
          attempted.delete(attempted.keys().next().value);
        }
        attempted.set(attemptKey, now);
      }
      try {
        try {
          await new Promise((resolve, reject) => {
            const isAsync = batch[0].header.folder.fetchMsgPreviewText(
              batch.map(({ header }) => header.messageKey),
              {
                OnStartRunningUrl() {},
                OnStopRunningUrl(_url, status) {
                  Components.isSuccessCode(status) ? resolve() : reject(status);
                },
              }
            );
            if (!isAsync) {
              resolve();
            }
          });
        } catch {
          // Some servers cannot supply alert-style excerpts; try the actual MIME body.
        }
        for (const { row, header, preview, key, attemptKey } of batch) {
          if (!active) {
            break;
          }
          try {
            let text = header.getStringProperty("preview").replace(/\s+/gu, " ").trim();
            if (!text) {
              if (!row.isConnected || row.thwMessage !== key || document.hidden ||
                  row.index < threadTree.getFirstVisibleIndex() ||
                  row.index > threadTree.getLastVisibleIndex()) {
                attempted.delete(attemptKey);
                continue;
              }
              const mime = await new Promise(resolve => {
                MsgHdrToMimeMessage(
                  header,
                  null,
                  (_header, message) => resolve(message),
                  !Services.io.offline,
                  // Truncating HTML before conversion can discard text after long style blocks.
                  { saneBodySize: false }
                );
              });
              if (!mime) {
                throw new Error("MIME streaming failed");
              }
              text = mime.coerceBodyToPlaintext(header.folder).replace(/\s+/gu, " ").trim().slice(0, 500);
              if (active && text) {
                header.setStringProperty("preview", text);
              }
            }
            if (active && row.isConnected && row.thwMessage === key) {
              preview.textContent = text;
            }
          } catch (error) {
            // Do not put subjects, addresses or body text in diagnostic messages.
            console.warn("ThwunderList: MIME preview unavailable", error.result || error.name);
          }
        }
      } finally {
        fetchingPreviews = false;
        schedulePreviews();
      }
    };

    const connectionObserver = {
      observe: () => {
        attempted.clear();
        if (Services.io.offline) {
          this.resetRemoteAvatars();
        }
        schedulePreviews();
      },
    };
    const resizeObserver = new window.ResizeObserver(schedulePreviews);

    const fill = function () {
      originalFill.call(this);
      // Another add-on may retain this wrapper after uninstall.
      if (!active) {
        return;
      }
      if (!this.querySelector(".thw-avatar")) {
        const avatar = document.createElement("span");
        avatar.className = "thw-avatar";
        avatar.setAttribute("aria-hidden", "true");
        this.querySelector(".read-status-column").after(avatar);
        const preview = document.createElement("div");
        preview.className = "thw-preview";
        // The native row already announces sender, subject and message state.
        preview.setAttribute("aria-hidden", "true");
        this.querySelector(".thread-card-column:last-child").append(preview);
      }
      const avatar = this.querySelector(".thw-avatar");
      const preview = this.querySelector(".thw-preview");
      preview.textContent = "";
      avatar.textContent = "";
      this.thwMessage = null;
      this.thwAvatarRequest = null;
      const properties = this.dataset.properties.split(" ");
      if (properties.includes("dummy")) {
        return;
      }

      const name = this.senderLine.textContent.split(/[,<@]/u)[0].trim();
      const words = name.match(/[\p{L}\p{N}]+/gu) || [];
      avatar.textContent = words.length
        ? (Array.from(words[0])[0] +
            (words.length > 1 ? Array.from(words.at(-1))[0] : "")).toLocaleUpperCase()
        : "•";

      try {
        const header = this.view.getMsgHdrAt(this.index);
        if (!header?.folder) {
          return;
        }
        try {
          const column = threadPane.cardColumns[1];
          const outgoing = column === "recipientCol" ||
            (column === "correspondentCol" && properties.includes("outgoing"));
          const [address] = MailServices.headerParser.parseDecodedHeader(
            outgoing ? header.mime2DecodedRecipients : header.mime2DecodedAuthor
          );
          if (!threadTree.hasAttribute("data-thw-hide-avatars")) {
            const requestRemote = () => {
              // A junk sender's domain could learn from the icon fetch that its mail was listed.
              if (properties.includes("junk") || header.folder.getFlag(Ci.nsMsgFolderFlags.Junk)) {
                return;
              }
              const key = `${header.folder.URI}#${header.messageKey} ${address?.email}`;
              const known = knownAvatar(key);
              if (known) {
                if (known.photo) {
                  showPhoto(avatar, known.photo);
                }
                return;
              }
              // Recipients you addressed need no proof; incoming senders do.
              this.thwAvatarRequest = { key, email: address?.email, header: outgoing ? null : header };
              schedulePreviews();
            };
            const photoURL = MailServices.ab.cardForEmailAddress(address?.email)?.photoURL;
            // Never load remote photo URLs stored in address-book entries.
            if (photoURL?.startsWith("file:///") ||
                /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(photoURL || "")) {
              showPhoto(avatar, { src: photoURL }, requestRemote);
            } else {
              requestRemote();
            }
          }
        } catch {
          // Invalid contacts must leave initials and message previews intact.
        }
        const key = header.folder.URI + "#" + header.messageKey;
        this.thwMessage = key;
        preview.textContent = header.getStringProperty("preview").replace(/\s+/gu, " ").trim();
        if (preview.textContent) {
          return;
        }
        schedulePreviews();
      } catch {
        // Virtual folders may briefly contain headers that have been deleted.
      }
    };

    const density = async function (...args) {
      await originalDensity.apply(this, args);
      if (!active) {
        return;
      }
      const fontSize = parseFloat(window.getComputedStyle(threadTree).fontSize);
      const previewLines = Services.prefs.getIntPref(PREVIEW_LINES_PREF, 2);
      const lineHeight = fontSize * 1.4;
      // Two header rows, preview lines, and the card's padding/gaps must all fit.
      const minimumHeight = Math.ceil(
        Math.max(lineHeight * 1.08, 16) + Math.max(lineHeight, 16) +
        lineHeight * previewLines + 18
      );
      const automaticHeight = Math.ceil(fontSize * (3.7 + 1.4 * previewLines) + 14);
      Card.ROW_HEIGHT = Math.max(automaticHeight, minimumHeight);
      threadTree.style.setProperty("--thw-row-height", Card.ROW_HEIGHT + "px");
      threadTree.style.setProperty("--thw-preview-lines", previewLines);
    };

    const cleanup = () => {
      active = false;
      window.removeEventListener("unload", cleanup);
      window.clearTimeout(previewTimer);
      resizeObserver.disconnect();
      threadTree.removeEventListener("scroll", schedulePreviews);
      document.removeEventListener("visibilitychange", schedulePreviews);
      Services.obs.removeObserver(connectionObserver, "network:offline-status-changed");
      if (Card.prototype.fillRow === fill) {
        Card.prototype.fillRow = originalFill;
      }
      if (threadPane.densityChange === density) {
        threadPane.densityChange = originalDensity;
      }
      Card.ROW_HEIGHT = originalHeight;
      if (!window.closed) {
        window.windowUtils.removeSheet(this.styleURI, window.windowUtils.USER_SHEET);
        threadTree.style.removeProperty("--thw-row-height");
        threadTree.style.removeProperty("--thw-preview-lines");
        threadTree.removeAttribute("data-thw-hide-avatars");
        threadTree.removeAttribute("data-thw-hide-account-colors");
        threadPane.updateThreadItemSize();
        // Remove injected nodes before shutdown, not after the async resize.
        threadTree.reset();
      }
      this.panes.delete(window);
    };
    this.panes.set(window, cleanup);
    window.addEventListener("unload", cleanup, { once: true });
    window.windowUtils.loadSheet(this.styleURI, window.windowUtils.USER_SHEET);
    threadTree.toggleAttribute("data-thw-hide-avatars", !Services.prefs.getBoolPref(AVATAR_PREF, true));
    threadTree.toggleAttribute("data-thw-hide-account-colors", !Services.prefs.getBoolPref(ACCOUNT_COLORS_PREF, true));
    Card.prototype.fillRow = fill;
    threadPane.densityChange = density;
    threadTree.addEventListener("scroll", schedulePreviews);
    document.addEventListener("visibilitychange", schedulePreviews);
    Services.obs.addObserver(connectionObserver, "network:offline-status-changed");
    resizeObserver.observe(threadTree);
    threadPane.updateThreadItemSize();
  }

  onShutdown(isAppShutdown) {
    // Disabling, updating or removing the add-on leaves no avatar data behind.
    if (!isAppShutdown) {
      this.wipeAvatarStore();
    }
    if (!this.panes || isAppShutdown) {
      return;
    }
    this.resetRemoteAvatars();
    Services.obs.removeObserver(this.observer, "chrome-document-loaded");
    for (const [window, load] of this.pending) {
      window.removeEventListener("load", load);
    }
    this.pending.clear();
    for (const cleanup of this.panes.values()) {
      cleanup();
    }
    for (const { cleanup } of this.menus.values()) {
      cleanup();
    }
  }
};
