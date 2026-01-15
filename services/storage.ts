import { db, auth } from '../lib/firebase';
import { collection, updateDoc, deleteDoc, doc, query, where, getDocs, setDoc, getDoc } from 'firebase/firestore';
import { Note } from '../types';

// Keys for Local Storage
const LOCAL_NOTES_KEY = 'chronos_notes';
const LOCAL_USAGE_KEY = 'chronos_usage';

interface UsageStats {
  count: number;
  weekStart: string; // ISO Date string
  isPremium: boolean;
}

// --- Helper: Timeout Wrapper ---
// Forces a promise to reject if it takes longer than 2 seconds, allowing quick fallback
const withTimeout = <T>(promise: Promise<T>, ms: number = 2000): Promise<T> => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Firestore operation timed out")), ms);
        promise.then(
            (res) => { clearTimeout(timer); resolve(res); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
};

// --- Helper: Get Current Week Start ---
const getWeekStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Set to Sunday
  return d.toISOString();
};

// --- Helper: Convert Firestore Doc to Note ---
const docToNote = (doc: any): Note => {
  const data = doc.data();
  return {
    ...data,
    id: doc.id,
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
  } as Note;
};

// --- Helper: Local Storage Operations ---
const getLocalNotesRaw = (): Note[] => {
  const saved = localStorage.getItem(LOCAL_NOTES_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    return parsed.map((n: any) => ({ ...n, createdAt: new Date(n.createdAt) }));
  } catch (e) { return []; }
};

const saveLocalNotesRaw = (notes: Note[]) => {
  localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(notes));
};

// ==========================================
// 1. NOTES OPERATIONS
// ==========================================

export const getNotes = async (): Promise<Note[]> => {
  const user = auth?.currentUser;

  // Real Backend: If user is logged in, try fetch from Firestore with Timeout
  if (user && db) {
    try {
      const q = query(collection(db, 'notes'), where('userId', '==', user.uid));
      // Wrap in timeout to prevent hanging
      const snapshot = await withTimeout(getDocs(q)) as any;
      const notes = snapshot.docs.map(docToNote);
      // Sort desc
      return notes.sort((a: Note, b: Note) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (e) {
      console.warn("Firestore access failed or timed out. Falling back to local storage.", e);
      // Fallthrough to local storage logic below
    }
  }

  // Guest Mode OR Fallback: Local Storage
  return getLocalNotesRaw();
};

export const saveNote = async (note: Note): Promise<void> => {
  const user = auth?.currentUser;

  // Real Backend: If logged in, try save to Firestore
  let savedToCloud = false;
  if (user && db) {
    try {
      const noteRef = doc(db, 'notes', note.id);
      await withTimeout(setDoc(noteRef, {
        ...note,
        userId: user.uid,
        createdAt: note.createdAt 
      }, { merge: true }));
      savedToCloud = true;
    } catch (e) {
      console.error("Firestore save failed. Falling back to local save.", e);
    }
  }

  // Fallback / Guest Mode: Save to Local Storage
  // If cloud save failed, OR if we are guest, we save locally.
  if (!savedToCloud) {
    const notes = getLocalNotesRaw();
    const existingIndex = notes.findIndex(n => n.id === note.id);
    let updatedNotes;
    if (existingIndex >= 0) {
      updatedNotes = notes.map(n => n.id === note.id ? note : n);
    } else {
      updatedNotes = [note, ...notes];
    }
    saveLocalNotesRaw(updatedNotes);
  }
};

export const deleteNoteById = async (id: string): Promise<void> => {
  const user = auth?.currentUser;
  let deletedFromCloud = false;

  // Real Backend
  if (user && db) {
    try {
      await withTimeout(deleteDoc(doc(db, 'notes', id)));
      deletedFromCloud = true;
    } catch (e) { 
        console.error("Firestore delete failed. Falling back to local delete.", e);
    }
  }

  // Fallback / Guest Mode
  if (!deletedFromCloud) {
      const notes = getLocalNotesRaw();
      const filtered = notes.filter(n => n.id !== id);
      saveLocalNotesRaw(filtered);
  }
};

// ==========================================
// 2. USAGE & PREMIUM LOGIC
// ==========================================

export const getUserStats = async (): Promise<UsageStats> => {
  const user = auth?.currentUser;
  const currentWeek = getWeekStart();

  if (user && db) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const snap = await withTimeout(getDoc(userRef)) as any;
        
        if (snap.exists()) {
          const data = snap.data();
          if (data.weekStart !== currentWeek) {
            // We don't necessarily need to block on this update
            updateDoc(userRef, { count: 0, weekStart: currentWeek }).catch(() => {});
            return { count: 0, weekStart: currentWeek, isPremium: !!data.isPremium };
          }
          return { count: data.count || 0, weekStart: data.weekStart, isPremium: !!data.isPremium };
        } else {
          // Attempt to create user doc
          const initial = { count: 0, weekStart: currentWeek, isPremium: false, email: user.email };
          await withTimeout(setDoc(userRef, initial));
          return initial;
        }
    } catch (e) {
        console.warn("Firestore stats fetch failed (using local stats)", e);
        // Fallthrough to local stats logic
    }
  }

  // LOCAL / Fallback
  const saved = localStorage.getItem(LOCAL_USAGE_KEY);
  let stats: UsageStats = saved ? JSON.parse(saved) : { count: 0, weekStart: currentWeek, isPremium: false };
  
  if (stats.weekStart !== currentWeek) {
    stats = { count: 0, weekStart: currentWeek, isPremium: stats.isPremium }; 
    localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(stats));
  }
  return stats;
};

export const incrementUsage = async (): Promise<void> => {
  const user = auth?.currentUser;
  // We get stats first (which handles resets and handles fallback logic internally)
  const stats = await getUserStats(); 
  
  if (user && db) {
    try {
        const userRef = doc(db, 'users', user.uid);
        await withTimeout(updateDoc(userRef, { count: stats.count + 1 }));
        return; // Success
    } catch (e) {
        console.warn("Firestore increment failed:", e);
    }
  } 
  
  // Guest mode or Fallback
  stats.count += 1;
  localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(stats));
};

export const setPremiumStatus = async (status: boolean): Promise<void> => {
  const user = auth?.currentUser;
  
  if (user && db) {
    try {
        const userRef = doc(db, 'users', user.uid);
        await withTimeout(setDoc(userRef, { isPremium: status }, { merge: true }));
        return;
    } catch (e) {
        console.warn("Firestore premium set failed:", e);
    }
  } 
  
  // Guest mode or Fallback
  const stats = await getUserStats();
  stats.isPremium = status;
  localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(stats));
};