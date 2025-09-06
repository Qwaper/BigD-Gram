// app.js
import { firebaseConfig } from "./config.js";

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  // CHANGED: use initializeFirestore instead of getFirestore
  initializeFirestore,
  // setLogLevel is handy if you want more logs while debugging transports:
  // setLogLevel,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  onSnapshot,
  addDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getDatabase,
  ref as rtdbRef,
  onValue,
  onDisconnect,
  set as rtdbSet,
  serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ---------------------------
   Firebase init
---------------------------- */
const app = initializeApp(firebaseConfig);

// If you need verbose logs while testing transports, uncomment:
// setLogLevel('debug');

/**
 * IMPORTANT TRANSPORT FIX:
 * Some networks/proxies/extensions break the default WebChannel stream
 * (you'll see 400s on .../Firestore/Listen and "client is offline").
 *
 * The settings below switch to more robust transports automatically:
 * - useFetchStreams: true → uses the modern fetch streaming transport
 * - experimentalAutoDetectLongPolling: true → falls back when streaming is blocked
 *
 * If your environment STILL blocks streaming, try forcing long polling:
 *   initializeFirestore(app, { experimentalForceLongPolling: true });
 * (Do not use force + fetchStreams together.)
 */
const db = initializeFirestore(app, {
  useFetchStreams: true,
  experimentalAutoDetectLongPolling: true,
  // experimentalForceLongPolling: true, // <— last-resort fallback; enable ONLY if needed
});

const auth = getAuth(app);
const rtdb = getDatabase(app);
const storage = getStorage(app);

/* ---------------------------
   DOM helpers
---------------------------- */
const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);
const esc = (s) => s.replace(/[&<>"'`]/g, (c) =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;" }[c])
);

/* ---------------------------
   UI refs
---------------------------- */
const authView = $("#auth-view");
const appView = $("#app-view");

const tabs = $$(".tab");
const loginForm = $("#login-form");
const loginIdentifier = $("#login-identifier");
const loginPassword = $("#login-password");
const loginError = $("#login-error");

const signupForm = $("#signup-form");
const signupUsername = $("#signup-username");
const signupEmail = $("#signup-email");
const signupPassword = $("#signup-password");
const signupError = $("#signup-error");

const meUsername = $("#me-username");
const meEmail = $("#me-email");
const meDot = $("#me-dot");
const logoutBtn = $("#logout-btn");

const searchForm = $("#search-form");
const searchUsername = $("#search-username");
const searchResults = $("#search-results");

const contactsEl = $("#contacts");
const onlineList = $("#online-list");

const chatHeader = $("#chat-header");
const chatPresence = $("#chat-presence");
const messagesEl = $("#messages");
const messageForm = $("#message-form");
const messageInput = $("#message-input");
const fileInput = $("#file-input");
const attachBtn = $("#attach-btn");
const sendBtn = $("#send-btn");
const uploadProgress = $("#upload-progress");

/* ---------------------------
   State
---------------------------- */
let currentUser = null;
let usersMap = new Map();               // uid -> { username, email, ... }
let onlineStatus = new Map();           // uid -> 'online'|'offline'
let contacts = new Map();               // otherUid -> { conversationId, username, ... }
let activeConversationId = null;
let activePeerUid = null;
let messagesUnsub = null;

/* ---------------------------
   Tabs (login/signup)
---------------------------- */
tabs.forEach(btn => {
  btn.addEventListener("click", () => {
    tabs.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const show = btn.dataset.tab;
    $$(".panel").forEach(p => p.classList.remove("active"));
    if (show === "login") $("#login-form").classList.add("active");
    else $("#signup-form").classList.add("active");
  });
});

/* ---------------------------
   Auth: Sign Up (username+email+password)
---------------------------- */
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signupError.textContent = "";

  const rawUsername = signupUsername.value.trim();
  const email = signupEmail.value.trim();
  const password = signupPassword.value;

  const username = rawUsername.toLowerCase();
  if (!/^[a-z0-9_\.]{3,20}$/.test(username)) {
    signupError.textContent = "Username must be 3–20 chars: a-z 0-9 _ .";
    return;
  }

  try {
    // (1) Ensure username isn't taken
    const unameRef = doc(db, "usernames", username);
    const nameSnap = await getDoc(unameRef);
    if (nameSnap.exists()) {
      signupError.textContent = "That username is already taken.";
      return;
    }

    // (2) Create auth user
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await updateProfile(cred.user, { displayName: rawUsername });

    // (3) Create user profile doc
    const userRef = doc(db, "users", uid);
    await setDoc(userRef, {
      uid,
      username: rawUsername,
      usernameLower: username,
      email,
      createdAt: serverTimestamp()
    });

    // (4) Claim the username
    await setDoc(unameRef, { uid }, { merge: false });

    // Done — state will switch via onAuthStateChanged
  } catch (err) {
    console.error(err);
    signupError.textContent = err.message || "Sign-up failed.";
  }
});

/* ---------------------------
   Auth: Login (username+pass OR email+pass)
---------------------------- */
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const identifier = loginIdentifier.value.trim();
  const password = loginPassword.value;

  try {
    let emailToUse = identifier;

    // If "identifier" doesn't look like an email, treat as username
    if (!identifier.includes("@")) {
      const unameRef = doc(db, "usernames", identifier.toLowerCase());
      const unameSnap = await getDoc(unameRef);
      if (!unameSnap.exists()) {
        loginError.textContent = "That username does not exist.";
        return;
      }
      const { uid } = unameSnap.data();
      const userSnap = await getDoc(doc(db, "users", uid));
      if (!userSnap.exists()) {
        loginError.textContent = "User profile missing.";
        return;
      }
      emailToUse = userSnap.data().email;
    }

    await signInWithEmailAndPassword(auth, emailToUse, password);
    // onAuthStateChanged will take it from here
  } catch (err) {
    console.error(err);
    // If transports are blocked you'll often see "client is offline".
    if (/offline/i.test(String(err?.message))) {
      loginError.textContent =
        "Network/extension is blocking Firestore streaming. Reload after disabling blockers, or try another network.";
    } else {
      loginError.textContent = "Login failed: " + (err.message || "");
    }
  }
});

/* ---------------------------
   Auth state
---------------------------- */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    await postLoginInit(user);
  } else {
    // cleanup
    tearDownChat();
    contacts.clear();
    activeConversationId = null; activePeerUid = null;
    usersMap.clear(); onlineStatus.clear();

    appView.classList.add("hidden");
    authView.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

/* ---------------------------
   Presence (Realtime Database)
---------------------------- */
function setupPresence(uid) {
  // Set online/offline in RTDB
  const statusRef = rtdbRef(rtdb, `/status/${uid}`);
  const connectedRef = rtdbRef(rtdb, ".info/connected");

  onValue(connectedRef, (snap) => {
    if (snap.val() === false) return;

    onDisconnect(statusRef).set({
      state: "offline",
      last_changed: rtdbServerTimestamp()
    }).then(() => {
      rtdbSet(statusRef, {
        state: "online",
        last_changed: rtdbServerTimestamp()
      });
    });
  });
}

/* ---------------------------
   Post-login init
---------------------------- */
let usersUnsub = null;
let statusUnsub = null;
let contactsUnsub = null;

async function postLoginInit(user) {
  // header
  meUsername.textContent = user.displayName || "—";
  meEmail.textContent = user.email || "";
  meDot.style.background = "#22c55e"; // green

  // presence
  setupPresence(user.uid);

  // live map of users (uid -> profile)
  if (usersUnsub) usersUnsub();
  usersUnsub = onSnapshot(collection(db, "users"), (snap) => {
    usersMap.clear();
    snap.forEach((d) => usersMap.set(d.id, d.data()));
    renderContactList();
    renderOnline();
  }, (err) => {
    console.error("users onSnapshot error", err);
  });

  // online status map from RTDB
  const statusRef = rtdbRef(rtdb, "/status");
  if (statusUnsub) statusUnsub();
  statusUnsub = onValue(statusRef, (snap) => {
    onlineStatus.clear();
    const val = snap.val() || {};
    Object.keys(val).forEach((uid) => {
      onlineStatus.set(uid, val[uid].state);
    });
    renderOnline();
    renderChatPresence();
  });

  // my contacts
  if (contactsUnsub) contactsUnsub();
  contactsUnsub = onSnapshot(collection(db, "users", user.uid, "contacts"), (snap) => {
    contacts.clear();
    snap.forEach((d) => contacts.set(d.id, d.data()));
    renderContactList();
  }, (err) => {
    console.error("contacts onSnapshot error", err);
  });
}

/* ---------------------------
   Search users by exact username
---------------------------- */
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = searchUsername.value.trim().toLowerCase();
  searchResults.innerHTML = "";
  if (!name) return;

  try {
    const unameRef = doc(db, "usernames", name);
    const nameSnap = await getDoc(unameRef);
    if (!nameSnap.exists()) {
      searchResults.innerHTML = `<div class="row"><div class="grow">No user found.</div></div>`;
      return;
    }
    const { uid } = nameSnap.data();
    if (uid === currentUser?.uid) {
      searchResults.innerHTML = `<div class="row"><div class="grow">That’s you 😄</div></div>`;
      return;
    }
    const profile = usersMap.get(uid);
    const isFriend = contacts.has(uid);

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dot" style="background:${onlineStatus.get(uid)==='online' ? '#22c55e' : '#9ca3af'}"></div>
      <div class="grow">
        <div class="title">@${esc(profile?.username || name)}</div>
        <div class="sub">${esc(profile?.email || "")}</div>
      </div>
      ${isFriend
        ? `<span class="pill">Friend</span><button class="small" data-msg="${uid}">Message</button>`
        : `<button class="small" data-add="${uid}">Add Friend</button>`}
    `;
    searchResults.appendChild(row);

    row.addEventListener("click", async (ev) => {
      const addUid = ev.target?.dataset?.add;
      const msgUid = ev.target?.dataset?.msg;
      if (addUid) {
        await addFriend(addUid);
      }
      if (msgUid) {
        const cId = await ensureConversation(currentUser.uid, msgUid);
        openConversation(cId, msgUid);
      }
    });
  } catch (err) {
    console.error(err);
    searchResults.innerHTML = `<div class="row"><div class="grow">Search failed. If you’re on a restricted network, try a different network or disable ad-block.</div></div>`;
  }
});

/* ---------------------------
   Contacts (friends)
---------------------------- */
function renderContactList() {
  contactsEl.innerHTML = "";
  const arr = Array.from(contacts.entries()); // [ [uid, data], ... ]
  if (arr.length === 0) {
    contactsEl.innerHTML = `<div class="row"><div class="grow">No friends yet. Use “Find Users”.</div></div>`;
    return;
  }

  arr.sort((a,b) => {
    const aName = (a[1].username || "").toLowerCase();
    const bName = (b[1].username || "").toLowerCase();
    return aName.localeCompare(bName);
  });

  arr.forEach(([uid, data]) => {
    const isOnline = onlineStatus.get(uid) === "online";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dot" style="background:${isOnline ? '#22c55e' : '#9ca3af'}"></div>
      <div class="grow">
        <div class="title">@${esc(data.username || usersMap.get(uid)?.username || "")}</div>
        <div class="sub">${isOnline ? "online" : "offline"}</div>
      </div>
      <button class="small" data-open="${uid}">Open</button>
    `;
    contactsEl.appendChild(row);

    row.addEventListener("click", async (ev) => {
      const openUid = ev.target?.dataset?.open;
      if (openUid) {
        activePeerUid = openUid;
        const cId = data.conversationId || await ensureConversation(currentUser.uid, openUid);
        openConversation(cId, openUid);
      }
    });
  });
}

/* ---------------------------
   Online list (all users online)
---------------------------- */
function renderOnline() {
  if (!usersMap.size) return;
  onlineList.innerHTML = "";

  const onlineUids = Array.from(onlineStatus.entries())
    .filter(([uid, s]) => s === "online" && uid !== (currentUser?.uid))
    .map(([uid]) => uid);

  if (onlineUids.length === 0) {
    onlineList.innerHTML = `<div class="row"><div class="grow">No one online right now.</div></div>`;
    return;
  }

  onlineUids.forEach((uid) => {
    const u = usersMap.get(uid);
    if (!u) return;
    const isFriend = contacts.has(uid);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dot" style="background:#22c55e"></div>
      <div class="grow">
        <div class="title">@${esc(u.username)}</div>
        <div class="sub">${esc(u.email || "")}</div>
      </div>
      ${isFriend
        ? `<button class="small" data-msg="${uid}">Message</button>`
        : `<button class="small" data-add="${uid}">Add</button>`}
    `;
    onlineList.appendChild(row);

    row.addEventListener("click", async (ev) => {
      const addUid = ev.target?.dataset?.add;
      const msgUid = ev.target?.dataset?.msg;
      if (addUid) {
        await addFriend(addUid);
      }
      if (msgUid) {
        const cId = await ensureConversation(currentUser.uid, msgUid);
        openConversation(cId, msgUid);
      }
    });
  });
}

/* ---------------------------
   Friends: add (mutual) & conversation
---------------------------- */
async function addFriend(otherUid) {
  const myUid = currentUser.uid;
  if (otherUid === myUid) return;

  const other = usersMap.get(otherUid);
  if (!other) return;

  const conversationId = conversationIdFor(myUid, otherUid);
  const convRef = doc(db, "conversations", conversationId);
  const convSnap = await getDoc(convRef);
  if (!convSnap.exists()) {
    await setDoc(convRef, {
      id: conversationId,
      participants: [myUid, otherUid],
      createdAt: serverTimestamp(),
      lastMessageAt: serverTimestamp()
    });
  }

  // create both contacts
  await Promise.all([
    setDoc(doc(db, "users", myUid, "contacts", otherUid), {
      userId: otherUid,
      username: other.username,
      conversationId,
      createdAt: serverTimestamp()
    }, { merge: true }),
    setDoc(doc(db, "users", otherUid, "contacts", myUid), {
      userId: myUid,
      username: currentUser.displayName || "",
      conversationId,
      createdAt: serverTimestamp()
    }, { merge: true })
  ]);

  // refresh list will happen via snapshot
}

function conversationIdFor(a, b) {
  return [a, b].sort().join("__");
}

async function ensureConversation(a, b) {
  const id = conversationIdFor(a, b);
  const ref = doc(db, "conversations", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      id,
      participants: [a, b],
      createdAt: serverTimestamp(),
      lastMessageAt: serverTimestamp()
    });
  }
  return id;
}

/* ---------------------------
   Chat open / render / live
---------------------------- */
async function openConversation(conversationId, peerUid) {
  activeConversationId = conversationId;
  activePeerUid = peerUid;

  const peer = usersMap.get(peerUid);
  const title = peer ? `@${peer.username}` : "Chat";
  $(".chat-title").textContent = title;
  renderChatPresence();

  messagesEl.innerHTML = "";
  messageForm.classList.remove("disabled");
  messageInput.focus();

  if (messagesUnsub) messagesUnsub();
  const q = query(
    collection(db, "conversations", conversationId, "messages"),
    orderBy("createdAt", "asc")
  );
  messagesUnsub = onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    snap.forEach((d) => {
      renderMessage(d.id, d.data());
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, (err) => {
    console.error("messages onSnapshot error", err);
  });
}

function renderChatPresence() {
  if (!activePeerUid) {
    chatPresence.textContent = "";
    return;
  }
  const state = onlineStatus.get(activePeerUid) || "offline";
  chatPresence.textContent = `Status: ${state}`;
}

/* ---------------------------
   Messages render
---------------------------- */
function renderMessage(id, data) {
  const mine = data.senderId === currentUser.uid;
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " mine" : "");
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (data.type === "image" && data.imageUrl) {
    const img = document.createElement("img");
    img.src = data.imageUrl;
    img.alt = "attachment";
    bubble.appendChild(img);
    if (data.text) {
      const cap = document.createElement("div");
      cap.textContent = data.text;
      bubble.appendChild(cap);
    }
  } else {
    bubble.innerHTML = esc(data.text || "");
  }

  el.appendChild(bubble);
  messagesEl.appendChild(el);
}

/* ---------------------------
   Send message (text + image/GIF)
---------------------------- */
messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!activeConversationId) return;

  if (!text && !fileInput.files.length) {
    return;
  }

  // If there's a file queued, upload first, then send message
  let imageUrl = null;
  if (fileInput.files.length) {
    imageUrl = await uploadImage(fileInput.files[0]);
    fileInput.value = ""; // reset
  }

  await addDoc(collection(db, "conversations", activeConversationId, "messages"), {
    senderId: currentUser.uid,
    text: text || "",
    type: imageUrl ? "image" : "text",
    imageUrl: imageUrl || null,
    createdAt: serverTimestamp()
  });

  // bump conversation
  await updateDoc(doc(db, "conversations", activeConversationId), {
    lastMessageAt: serverTimestamp()
  });

  messageInput.value = "";
});

attachBtn.addEventListener("click", () => fileInput.click());

async function uploadImage(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type)) {
    alert("Only images are allowed.");
    return null;
  }
  const path = `uploads/${currentUser.uid}/${Date.now()}_${file.name}`;
  const ref = storageRef(storage, path);

  uploadProgress.textContent = "Uploading…";
  const snap = await uploadBytes(ref, file);
  const url = await getDownloadURL(snap.ref);
  uploadProgress.textContent = "Uploaded ✔";
  setTimeout(() => uploadProgress.textContent = "", 1000);
  return url;
}

/* ---------------------------
   Clean up chat listener on logout
---------------------------- */
function tearDownChat() {
  if (messagesUnsub) messagesUnsub();
  if (usersUnsub) usersUnsub();
  if (statusUnsub) statusUnsub();
  if (contactsUnsub) contactsUnsub();
}

/* ---------------------------
   Minor UX
---------------------------- */
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});
