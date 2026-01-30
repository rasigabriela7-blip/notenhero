import {
  initializeApp
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';

import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  signOut,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  getDocs
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

// ---------- DOM helpers ----------
const qs = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => [...scope.querySelectorAll(sel)];

const state = {
  user: null,
  semesters: [],
  subjects: [],
  exams: new Map(), // subjectId -> [{...exam}]
  activeSemesterId: null,
  unsubSemesters: null,
  unsubSubjects: null,
  unsubExams: new Map()
};

const ui = {
  authCard: qs('#auth-card'),
  dashboard: qs('#dashboard'),
  subjectsCard: qs('#subjects-card'),
  gradesCard: qs('.grades'),
  userName: qs('#user-name'),
  logoutBtn: qs('#logout-btn'),
  semesterList: qs('#semester-list'),
  subjectList: qs('#subject-list'),
  avgAll: qs('#avg-all'),
  avgImportant: qs('#avg-important'),
  heroForm: qs('#hero-form'),
  heroOutput: qs('#hero-output'),
  activeSemesterLabel: qs('#active-semester-label'),
  configWarning: qs('#config-warning'),
  dismissConfig: qs('#dismiss-config')
};

// ---------- Firebase bootstrapping ----------
let app, auth, db, firebaseReady = false;

function showConfigOverlay(message) {
  ui.configWarning.classList.remove('hidden');
  if (message) {
    ui.configWarning.querySelector('p').textContent = message;
  }
}

try {
  const config = window.firebaseConfig;
  const isPlaceholder = !config || Object.values(config).some(v => String(v || '').includes('YOUR_'));

  if (!config || isPlaceholder) {
    showConfigOverlay();
    console.warn('Bitte Firebase-Konfiguration ergänzen.');
  }

  app = initializeApp(config || {});
  auth = getAuth(app);
  db = getFirestore(app);
  setPersistence(auth, browserLocalPersistence);
  auth.languageCode = 'de';
  firebaseReady = true;
} catch (err) {
  console.error('Firebase Init fehlgeschlagen:', err);
  showConfigOverlay('Firebase konnte nicht initialisiert werden. Prüfe firebase-config.js.');
}

ui.dismissConfig?.addEventListener('click', () => ui.configWarning.classList.add('hidden'));

// ---------- Utility ----------
const clamp = (num, min, max) => Math.min(Math.max(num, min), max);

function calcGrade(points, maxPoints) {
  if (maxPoints <= 0 || Number.isNaN(points) || Number.isNaN(maxPoints)) return null;
  const raw = 1 + 5 * (points / maxPoints);
  const grade = clamp(raw, 1, 6);
  return Number(grade.toFixed(2));
}

function formatGrade(value) {
  if (value === null || Number.isNaN(value)) return '–';
  return value.toFixed(2);
}

function toast(text, tone = 'info') {
  const bar = document.createElement('div');
  bar.textContent = text;
  bar.className = `toast ${tone}`;
  Object.assign(bar.style, {
    position: 'fixed',
    bottom: '18px',
    right: '18px',
    padding: '10px 14px',
    borderRadius: '12px',
    background: 'rgba(24,36,58,0.95)',
    color: '#e9f1ff',
    border: '1px solid #1f2b42',
    zIndex: 9999,
    boxShadow: '0 10px 30px rgba(0,0,0,0.35)'
  });
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 3200);
}

function setProtectedUI(enabled) {
  [ui.dashboard, ui.subjectsCard, ui.gradesCard].forEach(el => {
    if (!el) return;
    el.classList.toggle('disabled', !enabled);
  });
}

function clearCollections() {
  state.semesters = [];
  state.subjects = [];
  state.exams = new Map();
  renderSemesters();
  renderSubjects();
  renderAverages();
}

function unsubscribeAll() {
  if (state.unsubSemesters) state.unsubSemesters();
  if (state.unsubSubjects) state.unsubSubjects();
  state.unsubExams.forEach(fn => fn && fn());
  state.unsubExams.clear();
}

// ---------- Auth UI ----------
function setupTabs() {
  const tabs = qsa('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      qsa('.tab-content').forEach(pane => {
        pane.classList.toggle('hidden', pane.dataset.pane !== target);
      });
    });
  });
}

setupTabs();

// Auth forms
qs('#login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  const data = new FormData(e.target);
  try {
    await signInWithEmailAndPassword(auth, data.get('email'), data.get('password'));
    toast('Eingeloggt.');
  } catch (err) {
    toast(err.message || 'Login fehlgeschlagen', 'error');
  }
});

qs('#register-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  const data = new FormData(e.target);
  const name = data.get('displayName').trim();
  try {
    const { user } = await createUserWithEmailAndPassword(auth, data.get('email'), data.get('password'));
    await updateProfile(user, { displayName: name });
    await setDoc(doc(db, 'users', user.uid), {
      displayName: name,
      email: user.email,
      activeSemesterId: null,
      createdAt: Date.now()
    });
    await sendEmailVerification(user);
    toast('Account erstellt. Prüfe dein E-Mail für die Verifikation.');
  } catch (err) {
    toast(err.message || 'Registrierung fehlgeschlagen', 'error');
  }
});

qs('#reset-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  const email = new FormData(e.target).get('email');
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Reset-Mail gesendet.');
  } catch (err) {
    toast(err.message || 'Reset fehlgeschlagen', 'error');
  }
});

qs('#google-login')?.addEventListener('click', async () => {
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  try {
    const provider = new GoogleAuthProvider();
    const res = await signInWithPopup(auth, provider);
    const { user } = res;
    // ensure user doc exists
    await setDoc(doc(db, 'users', user.uid), {
      displayName: user.displayName || 'Ohne Name',
      email: user.email,
      activeSemesterId: null,
      createdAt: Date.now()
    }, { merge: true });
    toast('Mit Google angemeldet.');
  } catch (err) {
    toast(err.message || 'Google Login fehlgeschlagen', 'error');
  }
});

ui.logoutBtn?.addEventListener('click', () => signOut(auth));

// ---------- Auth state handling ----------
if (firebaseReady) {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    const loggedIn = Boolean(user);
    ui.userName.textContent = loggedIn ? (user.displayName || 'Ohne Name') : 'Gast';
    setProtectedUI(loggedIn && firebaseReady);
    ui.authCard.style.display = loggedIn ? 'none' : 'block';

    if (!loggedIn) {
      unsubscribeAll();
      clearCollections();
      return;
    }

    if (!user.emailVerified && user.providerData.some(p => p.providerId === 'password')) {
      toast('Hinweis: E-Mail noch nicht verifiziert.', 'info');
    }

    try {
      const userDocRef = doc(db, 'users', user.uid);
      const snap = await getDoc(userDocRef);
      if (snap.exists()) {
        state.activeSemesterId = snap.data().activeSemesterId || null;
      } else {
        await setDoc(userDocRef, {
          displayName: user.displayName || 'Ohne Name',
          email: user.email,
          activeSemesterId: null,
          createdAt: Date.now()
        });
      }
    } catch (err) {
      console.error(err);
      toast('Konnte Benutzerdaten nicht laden.', 'error');
    }

    watchSemesters();
  });
} else {
  setProtectedUI(false);
  ui.authCard?.classList.remove('hidden');
}

// ---------- Firestore watchers ----------
function watchSemesters() {
  unsubscribeAll();
  const semRef = collection(db, 'users', state.user.uid, 'semesters');
  state.unsubSemesters = onSnapshot(query(semRef, orderBy('createdAt', 'asc')), async (snap) => {
    state.semesters = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (!state.semesters.length) {
      state.activeSemesterId = null;
    }
    // If no active semester set but at least one exists, pick first
    if (!state.activeSemesterId && state.semesters.length) {
      state.activeSemesterId = state.semesters[0].id;
      await setDoc(doc(db, 'users', state.user.uid), { activeSemesterId: state.activeSemesterId }, { merge: true });
    }
    renderSemesters();
    watchSubjects(state.activeSemesterId);
  });
}

function watchSubjects(semesterId) {
  if (!semesterId) {
    state.subjects = [];
    renderSubjects();
    renderAverages();
    return;
  }
  if (state.unsubSubjects) state.unsubSubjects();
  state.unsubExams.forEach(fn => fn && fn());
  state.unsubExams.clear();

  const subjRef = collection(db, 'users', state.user.uid, 'semesters', semesterId, 'subjects');
  state.unsubSubjects = onSnapshot(query(subjRef, orderBy('name', 'asc')), (snap) => {
    state.subjects = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // attach exam listeners for each subject
    const currentIds = new Set(state.subjects.map(s => s.id));
    // cleanup removed subjects' listeners
    [...state.unsubExams.keys()].forEach(subjId => {
      if (!currentIds.has(subjId)) {
        state.unsubExams.get(subjId)?.();
        state.unsubExams.delete(subjId);
        state.exams.delete(subjId);
      }
    });

    state.subjects.forEach(subj => attachExamListener(semesterId, subj.id));
    renderSubjects();
    renderAverages();
  });
}

function attachExamListener(semesterId, subjectId) {
  if (state.unsubExams.has(subjectId)) return;
  const examRef = collection(db, 'users', state.user.uid, 'semesters', semesterId, 'subjects', subjectId, 'exams');
  const unsub = onSnapshot(query(examRef, orderBy('name', 'asc')), (snap) => {
    state.exams.set(subjectId, snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    renderSubjects();
    renderAverages();
  });
  state.unsubExams.set(subjectId, unsub);
}

// ---------- Renderers ----------
function renderSemesters() {
  const list = ui.semesterList;
  list.innerHTML = '';
  if (!state.semesters.length) {
    list.classList.add('empty');
    list.innerHTML = '<p class="muted">Noch keine Semester.</p>';
    ui.activeSemesterLabel.textContent = 'Kein aktives Semester gewählt.';
    return;
  }
  list.classList.remove('empty');

  state.semesters.forEach(sem => {
    const item = document.createElement('div');
    item.className = 'item';
    item.dataset.id = sem.id;
    const isActive = sem.id === state.activeSemesterId;
    item.innerHTML = `
      <div class="item-header">
        <span class="color-dot" style="background:${sem.color || '#38c8a0'}"></span>
        <div>
          <div class="muted-strong">${sem.name || 'Unbenannt'}</div>
          <small class="muted">${isActive ? 'Aktiv' : 'Inaktiv'}</small>
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost small" data-action="set-active">${isActive ? 'Aktiv' : 'Aktivieren'}</button>
        <button class="btn ghost small" data-action="rename">Umbenennen</button>
        <button class="btn ghost small" data-action="delete">Löschen</button>
      </div>
    `;
    list.appendChild(item);
  });

  const active = state.semesters.find(s => s.id === state.activeSemesterId);
  ui.activeSemesterLabel.textContent = active ? `Aktives Semester: ${active.name}` : 'Kein aktives Semester gewählt.';
}

function renderSubjects() {
  const container = ui.subjectList;
  container.innerHTML = '';
  if (!state.activeSemesterId) {
    container.classList.add('empty');
    container.innerHTML = '<p class="muted">Wähle ein Semester, um Fächer zu sehen.</p>';
    return;
  }
  if (!state.subjects.length) {
    container.classList.add('empty');
    container.innerHTML = '<p class="muted">Noch keine Fächer im aktiven Semester.</p>';
    return;
  }
  container.classList.remove('empty');

  state.subjects.forEach(subj => {
    const avg = computeSubjectAverage(subj.id);
    const exams = state.exams.get(subj.id) || [];
    const card = document.createElement('div');
    card.className = 'card panel';
    card.innerHTML = `
      <div class="card-header">
        <div>
          <h3>${subj.name}</h3>
          <div class="chips">
            <span class="chip">Schnitt: ${formatGrade(avg)}</span>
            <span class="chip">Prüfungen: ${exams.length}</span>
            ${subj.important ? '<span class="chip" style="border-color:#3dd6a0;color:#3dd6a0;">Wichtig</span>' : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost small" data-action="toggle-important" data-id="${subj.id}">${subj.important ? 'Unmark.' : 'Wichtig'}</button>
          <button class="btn ghost small" data-action="rename-subject" data-id="${subj.id}">Umbenennen</button>
          <button class="btn ghost small" data-action="delete-subject" data-id="${subj.id}">Löschen</button>
        </div>
      </div>

      <form class="row exam-form" data-id="${subj.id}">
        <input name="name" placeholder="Prüfungsname" required>
        <input name="points" type="number" min="0" step="0.01" placeholder="Punkte" required>
        <input name="maxPoints" type="number" min="0.01" step="0.01" placeholder="Max" required>
        <input name="weight" type="number" min="1" step="1" placeholder="Gew. 100 = 100%" required>
        <button class="btn primary small" type="submit">Prüfung</button>
      </form>

      <div class="exam-list">
        ${exams.map(ex => renderExam(subj.id, ex)).join('')}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderExam(subjectId, exam) {
  const grade = calcGrade(Number(exam.points), Number(exam.maxPoints));
  return `
    <div class="exam-card" data-exam-id="${exam.id}" data-subject="${subjectId}">
      <div>
        <div class="muted-strong">${exam.name}</div>
        <div class="chips">
          <span class="chip">Punkte: ${exam.points}/${exam.maxPoints}</span>
          <span class="chip">Gewichtung: ${exam.weight}</span>
          <span class="chip">Note: ${formatGrade(grade)}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost small" data-action="edit-exam" data-id="${exam.id}" data-subject="${subjectId}">Bearbeiten</button>
        <button class="btn ghost small" data-action="delete-exam" data-id="${exam.id}" data-subject="${subjectId}">Löschen</button>
      </div>
    </div>
  `;
}

function renderAverages() {
  const subjectsWithAvg = state.subjects
    .map(s => ({ ...s, avg: computeSubjectAverage(s.id) }))
    .filter(s => s.avg !== null);

  const mean = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const avgAll = mean(subjectsWithAvg.map(s => s.avg));
  const avgImportant = mean(subjectsWithAvg.filter(s => s.important).map(s => s.avg));

  ui.avgAll.textContent = formatGrade(avgAll);
  ui.avgImportant.textContent = formatGrade(avgImportant);
}

function computeSubjectAverage(subjectId) {
  const exams = state.exams.get(subjectId) || [];
  if (!exams.length) return null;
  let weightedSum = 0;
  let weightTotal = 0;
  exams.forEach(ex => {
    const grade = calcGrade(Number(ex.points), Number(ex.maxPoints));
    const weight = Number(ex.weight) || 0;
    if (grade === null) return;
    weightedSum += grade * weight;
    weightTotal += weight;
  });
  if (weightTotal === 0) return null;
  return Number((weightedSum / weightTotal).toFixed(2));
}

// ---------- Forms ----------
qs('#semester-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  if (!state.user) return;
  const data = new FormData(e.target);
  const payload = {
    name: data.get('name').trim() || 'Semester',
    color: data.get('color'),
    createdAt: Date.now()
  };
  try {
    await addDoc(collection(db, 'users', state.user.uid, 'semesters'), payload);
    e.target.reset();
  } catch (err) {
    toast('Semester konnte nicht angelegt werden.', 'error');
  }
});

qs('#subject-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase ist nicht konfiguriert.', 'error');
  if (!state.activeSemesterId) {
    toast('Bitte zuerst ein aktives Semester wählen.', 'error');
    return;
  }
  const data = new FormData(e.target);
  const payload = {
    name: data.get('name').trim(),
    important: data.get('important') === 'on',
    createdAt: Date.now()
  };
  try {
    await addDoc(collection(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects'), payload);
    e.target.reset();
  } catch (err) {
    toast('Fach konnte nicht angelegt werden.', 'error');
  }
});

ui.semesterList.addEventListener('click', async (e) => {
  if (!firebaseReady || !state.user) return;
  const action = e.target.dataset.action;
  if (!action) return;
  const parent = e.target.closest('.item');
  if (!parent) return;
  const semId = parent.dataset.id;

  if (action === 'set-active') {
    state.activeSemesterId = semId;
    await setDoc(doc(db, 'users', state.user.uid), { activeSemesterId: semId }, { merge: true });
    renderSemesters();
    watchSubjects(semId);
  }

  if (action === 'rename') {
    const current = state.semesters.find(s => s.id === semId);
    const name = prompt('Neuer Name für das Semester', current?.name || '');
    if (!name) return;
    await updateDoc(doc(db, 'users', state.user.uid, 'semesters', semId), { name: name.trim() });
  }

  if (action === 'delete') {
    const confirmDelete = confirm('Semester inkl. aller Fächer und Prüfungen löschen?');
    if (!confirmDelete) return;
    await deleteSemesterCascade(semId);
  }
});

async function deleteSemesterCascade(semId) {
  // delete exams -> subjects -> semester
  const subjRef = collection(db, 'users', state.user.uid, 'semesters', semId, 'subjects');
  const subjSnap = await getDocs(subjRef);
  for (const subj of subjSnap.docs) {
    const examRef = collection(db, 'users', state.user.uid, 'semesters', semId, 'subjects', subj.id, 'exams');
    const examSnap = await getDocs(examRef);
    for (const ex of examSnap.docs) {
      await deleteDoc(ex.ref);
    }
    await deleteDoc(subj.ref);
  }
  await deleteDoc(doc(db, 'users', state.user.uid, 'semesters', semId));
  if (state.activeSemesterId === semId) {
    state.activeSemesterId = null;
    await setDoc(doc(db, 'users', state.user.uid), { activeSemesterId: null }, { merge: true });
  }
}

ui.subjectList.addEventListener('click', async (e) => {
  if (!firebaseReady || !state.user) return;
  const action = e.target.dataset.action;
  if (!action) return;
  const subjectId = e.target.dataset.subject || e.target.dataset.id;
  if (!subjectId) return;

  if (action === 'toggle-important') {
    const subj = state.subjects.find(s => s.id === subjectId);
    await updateDoc(doc(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId), { important: !subj?.important });
  }

  if (action === 'rename-subject') {
    const subj = state.subjects.find(s => s.id === subjectId);
    const name = prompt('Neuer Fachname', subj?.name || '');
    if (!name) return;
    await updateDoc(doc(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId), { name: name.trim() });
  }

  if (action === 'delete-subject') {
    const ok = confirm('Fach inkl. Prüfungen löschen?');
    if (!ok) return;
    await deleteSubjectCascade(subjectId);
  }

  if (action === 'edit-exam' || action === 'delete-exam') {
    const examId = e.target.dataset.id;
    const exams = state.exams.get(subjectId) || [];
    const exam = exams.find(ex => ex.id === examId);
    if (!exam) return;

    if (action === 'delete-exam') {
      await deleteDoc(doc(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId, 'exams', examId));
    }

    if (action === 'edit-exam') {
      const name = prompt('Prüfungsname', exam.name) || exam.name;
      const points = parseFloat(prompt('Punkte', exam.points));
      const maxPoints = parseFloat(prompt('Max-Punkte', exam.maxPoints));
      const weight = parseFloat(prompt('Gewichtung', exam.weight));
      if ([points, maxPoints, weight].some(n => Number.isNaN(n))) {
        toast('Ungültige Eingabe.', 'error');
        return;
      }
      await updateDoc(doc(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId, 'exams', examId), {
        name,
        points,
        maxPoints,
        weight
      });
    }
  }
});

async function deleteSubjectCascade(subjectId) {
  const examRef = collection(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId, 'exams');
  const snap = await getDocs(examRef);
  for (const ex of snap.docs) {
    await deleteDoc(ex.ref);
  }
  await deleteDoc(doc(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId));
}

// Exam form (delegated)
ui.subjectList.addEventListener('submit', async (e) => {
  if (!e.target.classList.contains('exam-form')) return;
  e.preventDefault();
  if (!firebaseReady || !state.user) return toast('Firebase ist nicht konfiguriert.', 'error');
  const subjectId = e.target.dataset.id;
  const data = new FormData(e.target);
  const payload = {
    name: data.get('name').trim() || 'Prüfung',
    points: Number(data.get('points')),
    maxPoints: Number(data.get('maxPoints')),
    weight: Number(data.get('weight')) || 0,
    createdAt: Date.now()
  };
  if (payload.maxPoints <= 0 || payload.weight <= 0) {
    toast('Max-Punkte und Gewichtung müssen > 0 sein.', 'error');
    return;
  }
  try {
    await addDoc(collection(db, 'users', state.user.uid, 'semesters', state.activeSemesterId, 'subjects', subjectId, 'exams'), payload);
    e.target.reset();
  } catch (err) {
    toast('Prüfung konnte nicht gespeichert werden.', 'error');
  }
});

// ---------- Noten-Hero ----------
ui.heroForm?.addEventListener('input', () => {
  const data = new FormData(ui.heroForm);
  const points = Number(data.get('points'));
  const maxPoints = Number(data.get('maxPoints'));
  const grade = calcGrade(points, maxPoints);
  ui.heroOutput.textContent = formatGrade(grade);
});

// ---------- Initial state ----------
setProtectedUI(false);
renderSemesters();
renderSubjects();
renderAverages();
