var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
  "resource:///modules/gloda/MimeMessage.sys.mjs"
);

const AVATAR_PREF = "extensions.thwunderlist.showAvatars";
const PREVIEW_LINES_PREF = "extensions.thwunderlist.previewLines";

this.mailList = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      mailList: {
        start: () => this.start(context.extension),
        getShowAvatars: async () => Services.prefs.getBoolPref(AVATAR_PREF, true),
        setShowAvatars: async showAvatars => this.setShowAvatars(showAvatars),
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
      },
    };
  }

  setShowAvatars(showAvatars) {
    Services.prefs.setBoolPref(AVATAR_PREF, showAvatars);
    for (const window of this.panes?.keys() ?? []) {
      window.threadTree.toggleAttribute("data-thw-hide-avatars", !showAvatars);
      window.threadTree.invalidate();
    }
    for (const { item } of this.menus?.values() ?? []) {
      item.toggleAttribute("checked", showAvatars);
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
    const cleanup = () => {
      item.remove();
      window.removeEventListener("unload", cleanup);
      this.menus.delete(window);
    };
    this.menus.set(window, { item, cleanup });
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
    let active = true;

    const schedulePreviews = () => {
      if (!active || previewTimer || fetchingPreviews) {
        return;
      }
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        fetchPreviews();
      }, 75);
    };

    const fetchPreviews = async () => {
      if (!active || document.hidden ||
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
      observe() {
        attempted.clear();
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
          const photoURL = threadTree.hasAttribute("data-thw-hide-avatars")
            ? null
            : MailServices.ab.cardForEmailAddress(address?.email)?.photoURL;
          // Never load remote photo URLs stored in address-book entries.
          if (photoURL?.startsWith("file:///") ||
              /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(photoURL || "")) {
            const photo = document.createElement("img");
            photo.alt = "";
            photo.hidden = true;
            photo.decoding = "async";
            photo.addEventListener("load", () => { photo.hidden = false; }, { once: true });
            photo.addEventListener("error", () => photo.remove(), { once: true });
            photo.src = photoURL;
            avatar.append(photo);
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
    Card.prototype.fillRow = fill;
    threadPane.densityChange = density;
    threadTree.addEventListener("scroll", schedulePreviews);
    document.addEventListener("visibilitychange", schedulePreviews);
    Services.obs.addObserver(connectionObserver, "network:offline-status-changed");
    resizeObserver.observe(threadTree);
    threadPane.updateThreadItemSize();
  }

  onShutdown(isAppShutdown) {
    if (!this.panes || isAppShutdown) {
      return;
    }
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
