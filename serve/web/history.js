// serve/web/history.js - what the chat history does to a list of messages. Pure functions: no page, no storage, no clock of
// their own, so they can be tested alone (serve/test_web_history.js). app.js draws the controls and keeps the state.
//
// One design for five proposals (see docs/DETAILS.md, "The web page"):
//   #2615 (uppet)         edit your question, correct an answer, regenerate, go back, undo
//   #1787 (Scotty-Hudson)  saved chats in a list, kept in this browser (IndexedDB), renamed, deleted, searched
//   #3823 (xvcezrqpbxtpzblrt) "Rewind to here" asks: edit and send again HERE, or BRANCH into a new chat
//   #3550 / #4004           the header's Load / Unload; sending while an answer is being written (app.js)
// A message list is an array of {role, text, time, images, files, reasoning, tools, meta, ...}; an attachment that was read
// in this page has its contents (image url, file text), one that came back from the browser's store has its name only.
"use strict";
(function (root) {
  const TITLE_MAX = 60;

  const newChatId = (now, rnd) => `c${now.toString(36)}${Math.floor(rnd * 1e6).toString(36)}`;
  function newChat(now = Date.now(), rnd = Math.random()) {
    return {id: newChatId(now, rnd), title: "", time: now, messages: []};
  }
  // the name in the list: what the user called it, else the first line of their first question, else the caller's word for "new"
  function chatTitle(c, untitled = "New chat") {
    if (c.title) return c.title;
    const first = (c.messages.find((m) => m.role === "user") || {}).text || "";
    return first.split("\n")[0].trim().slice(0, TITLE_MAX) || untitled;
  }

  // pictures and files are kept as their names only: a data URL would fill the browser's storage
  const cleanMessages = (list) => list.map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                                    files: (m.files || []).map((f) => ({name: f.name}))}));
  const cleanChat = (c) => ({...c, messages: cleanMessages(c.messages)});

  // Export: the whole list as one JSON file the user keeps, so a cache purge cannot take the chats. The contents an
  // attachment has in this page (a picture's data, a file's text) go in, so the file is a full backup; a chat that
  // came back from the browser's store holds its names only, and the file keeps it that way. A copy: the export
  // never touches the chats on the screen.
  function exportChats(chats, now = Date.now()) {
    return {app: "strata", kind: "chats", version: 1, exported: now,
            chats: chats.map((c) => JSON.parse(JSON.stringify(c)))};
  }

  // Import: read back a file exportChats wrote. A chat is accepted only when it has the shape the page can show: an
  // id and a messages array, and every message a role and a text; the rest goes to `invalid`. What an attachment
  // claims to hold is kept only as far as it can be shown safely here: a picture's url goes straight into an <img>,
  // so it must be a data: image no bigger than what this page would have attached itself; a file's text must be a
  // string within the page's own attach limit. Anything else keeps its name only, like a chat that came back from
  // the browser's store. Then the merge: a chat whose content matches one already here is skipped, so importing the
  // same file twice adds nothing; a chat whose id is taken by a *different* chat comes in as a new one under a fresh
  // id, keeping its title, date, messages and parent title -- the chat already here is never touched. A branch that
  // came in with its original is re-linked to where the original landed. The chats already here are never touched.
  const IMPORT_TEXT_MAX = 512 * 1024;        // app.js MAX_TEXT_FILE: the biggest attached text file the page reads
  const IMPORT_IMAGE_MAX = 20 * 1024 * 1024; // a data URL past this was never attached by this page
  function safeAttachment(a, isImage) {
    if (!a || typeof a !== "object") return null;
    const name = typeof a.name === "string" ? a.name : "";
    if (!isImage) return typeof a.text === "string" && a.text.length <= IMPORT_TEXT_MAX ? {...a, name} : {name};
    const ok = typeof a.url === "string" && /^data:image\//i.test(a.url) && a.url.length <= IMPORT_IMAGE_MAX;
    return ok ? {...a, name, url: a.url} : {name};
  }
  const importMessage = (m) => {
    if (!m || typeof m !== "object" || typeof m.role !== "string" || typeof m.text !== "string") return null;
    return {...m, images: (Array.isArray(m.images) ? m.images : []).map((a) => safeAttachment(a, true)).filter(Boolean),
               files: (Array.isArray(m.files) ? m.files : []).map((a) => safeAttachment(a, false)).filter(Boolean)};
  };
  // A fingerprint of what a chat *is*: the same chat exported twice gives the same key, whatever its id. Object keys are
  // sorted so the order they were written in does not matter; the id and the parent's id are blanked because the merge
  // decides those, not the content; an attachment counts by its name only, because a chat that came back from the
  // browser's store holds names only and is the same chat. Arrays keep their order -- the messages are the conversation.
  const named = (list) => (Array.isArray(list) ? list : []).map((a) => ({name: a && typeof a === "object" ? a.name : ""}));
  function stableKey(c) {
    const body = {title: c.title, time: c.time,
                  parent: c.parent && typeof c.parent === "object" ? {title: c.parent.title} : null,
                  messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => m && typeof m === "object"
                    ? {...m, images: named(m.images), files: named(m.files)} : m)};
    const canon = (v) => {
      if (Array.isArray(v)) return v.map(canon);
      if (v && typeof v === "object") return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
      return v;
    };
    return JSON.stringify(canon(body));
  }
  function importChats(existing, incoming, now = Date.now(), rnd = Math.random) {
    const out = {chats: [], skipped: 0, renamed: 0, invalid: 0};
    const here = new Map(); // content key -> the chat already here with it, so an identical import is skipped
    for (const c of existing) here.set(stableKey(c), c);
    const taken = new Set(existing.map((c) => c.id));
    const accepted = []; // where each imported chat landed -- to re-link branches after the loop
    let seed = rnd();
    for (const c of Array.isArray(incoming) ? incoming : []) {
      const shaped = c && typeof c === "object" && typeof c.id === "string" && c.id && Array.isArray(c.messages);
      const messages = shaped ? c.messages.map(importMessage) : null;
      if (!messages || messages.some((m) => m === null)) { out.invalid++; continue; }
      const chat = {...c, title: typeof c.title === "string" ? c.title : "",
                    time: Number.isFinite(c.time) ? c.time : now, messages};
      if (chat.parent && typeof chat.parent === "object") {
        chat.parent = {id: typeof chat.parent.id === "string" ? chat.parent.id : "",
                       title: typeof chat.parent.title === "string" ? chat.parent.title : ""};
      } else delete chat.parent;
      if (here.has(stableKey(chat))) { out.skipped++; continue; } // the same chat, by content: nothing to add
      const claimed = chat.id;                                   // the id the file said, before any rename
      if (taken.has(chat.id)) {                                  // a different chat under a used id: a new one
        let fresh;
        do { fresh = newChatId(now, seed++); } while (taken.has(fresh));
        chat.id = fresh;
        out.renamed++;
      }
      taken.add(chat.id);
      here.set(stableKey(chat), chat);
      accepted.push([claimed, chat]);
    }
    // a branch whose original came in the same file points at where the original landed; one whose original is
    // already here (or gone) keeps its parent title, and the page only links when the id is in the list
    const landed = new Map(accepted);
    for (const [, chat] of accepted) {
      if (!chat.parent) continue;
      const moved = landed.get(chat.parent.id);
      if (moved && moved.id !== chat.parent.id) chat.parent = {...chat.parent, id: moved.id};
    }
    out.chats.push(...accepted.map(([, chat]) => chat));
    return out;
  }

  // "today" | "yesterday" | "week" | "month" | "older", by calendar days back from now
  function groupKey(t, now = Date.now()) {
    const days = Math.floor((now - t) / 86400000);
    if (!days) return "today";
    if (days === 1) return "yesterday";
    if (days <= 7) return "week";
    if (days <= 30) return "month";
    return "older";
  }
  // the list for a search box: titles and message text, newest first
  function filterChats(chats, query, untitled) {
    const q = String(query || "").trim().toLowerCase();
    return chats.filter((c) => !q || chatTitle(c, untitled).toLowerCase().includes(q) ||
                               c.messages.some((m) => (m.text || "").toLowerCase().includes(q)))
                .sort((a, b) => b.time - a.time);
  }

  // Can a user turn be sent again as it was? A picture or file that came back from the browser's store has only its name.
  const lostAttachments = (m) => ((m.images || []).filter((x) => !x.url).length + (m.files || []).filter((x) => typeof x.text !== "string").length);
  // what goes back into the message box when a user turn is edited: its text and the attachments that still have contents
  function draftOf(m) {
    return {text: m.text || "",
            images: (m.images || []).filter((x) => x.url).map((x) => ({kind: "image", name: x.name, url: x.url})),
            files: (m.files || []).filter((x) => typeof x.text === "string").map((x) => ({kind: "file", name: x.name, text: x.text})),
            lost: lostAttachments(m)};
  }

  // "Rewind to here" on message i. A user turn goes back into the box and leaves the list; an answer stays and the list ends
  // with it. {keep, draft, hidden}: the messages that stay, the draft for the box (null for an answer), how many are hidden.
  function rewind(messages, i) {
    const m = messages[i];
    if (!m) return null;
    if (m.role === "user") return {keep: messages.slice(0, i), draft: draftOf(m), hidden: messages.length - i};
    return {keep: messages.slice(0, i + 1), draft: null, hidden: messages.length - i - 1};
  }
  // Regenerate the answer at i (or the last user turn): the list up to and including the user turn before it
  function regenerate(messages, i) {
    let u = i;
    while (u >= 0 && messages[u] && messages[u].role !== "user") u--;
    if (u < 0 || !messages[u]) return null;
    return {keep: messages.slice(0, u + 1), hidden: messages.length - u - 1};
  }
  // Edit the answer at i: its text replaced, its thinking, tool calls, error and stats dropped, everything after it hidden
  function editAnswer(messages, i, text, meta = "Edited") {
    const m = messages[i];
    if (!m || m.role !== "assistant") return null;
    return {keep: [...messages.slice(0, i), {role: "assistant", text, time: m.time, meta}], hidden: messages.length - i - 1};
  }
  // A branch: a new chat that starts with a copy of the first `end` messages. The original is not touched. The title says
  // where it came from and stays: the first question does not rename it (the first-message case of #3823).
  function branch(chat, messages, end, title, now = Date.now(), rnd = Math.random()) {
    const copy = JSON.parse(JSON.stringify(messages.slice(0, end)));
    return {...newChat(now, rnd), title, parent: {id: chat.id, title: chatTitle(chat)}, messages: copy};
  }

  const api = {TITLE_MAX, newChat, chatTitle, cleanMessages, cleanChat, exportChats, stableKey, importChats, groupKey, filterChats, lostAttachments,
               draftOf, rewind, regenerate, editAnswer, branch};
  root.StrataHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
