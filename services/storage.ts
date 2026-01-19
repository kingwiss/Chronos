import { db, auth } from '../lib/firebase';
import { collection, updateDoc, deleteDoc, doc, query, where, getDocs, setDoc, getDoc, Timestamp, QuerySnapshot, DocumentSnapshot, DocumentData } from 'firebase/firestore';
import { Note } from '../types';

interface UsageStats {
  count: number;
  weekStart: string; // ISO Date string
  isPremium: boolean;
}

// --- Helper: Timeout Wrapper ---
const withTimeout = <T>(promise: Promise<T>, ms: number = 3000): Promise<T> => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Firestore operation timed out")), ms);
        promise.then(
            (res) => { clearTimeout(timer); resolve(res); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
};

// --- Helper: Get Current Week Start ---
// Returns midnight on Sunday of the current week to ensure consistent resets
const getWeekStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
  return d.toISOString();
};

// --- KEY GENERATORS ---
const getUserContext = (explicitUserId?: string | null) => {
    // Priority: Explicit ID -> Auth ID -> Guest
    const uid = explicitUserId !== undefined ? explicitUserId : (auth.currentUser?.uid || null);
    const isGuest = !uid || uid === 'guest';
    const effectiveUid = isGuest ? 'guest' : uid;
    
    return {
        uid: effectiveUid,
        isGuest,
        // Unique keys for every user ensure strict data isolation on the same device
        notesKey: `chronos_notes_${effectiveUid}`,
        statsKey: `chronos_stats_${effectiveUid}`
    };
};

// --- STORAGE FUNCTIONS ---

export const getNotes = async (userId?: string | null): Promise<Note[]> => {
  const { uid, isGuest, notesKey } = getUserContext(userId);
  
  // 1. Load Local Cache First (Instant Render)
  const localData = localStorage.getItem(notesKey);
  let notes: Note[] = [];
  
  if (localData) {
      try {
          const parsed = JSON.parse(localData);
          notes = parsed.map((n: any) => ({
              ...n,
              createdAt: new Date(n.createdAt),
              alarm: n.alarm ? { ...n.alarm } : undefined
          }));
      } catch (e) {
          console.error("Failed to parse local notes", e);
      }
  }

  // 2. If User is Logged In, Sync with Cloud
  if (!isGuest && uid) {
    try {
      const notesRef = collection(db, 'users', uid, 'notes');
      const snapshot = await withTimeout(getDocs(notesRef)) as QuerySnapshot<DocumentData>;
      
      if (!snapshot.empty) {
        const remoteNotes = snapshot.docs.map(doc => {
           const data = doc.data();
           return {
               ...data,
               id: doc.id,
               createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date(data.createdAt)
           } as Note;
        });

        // Remote is truth. Overwrite local cache to ensure consistency across devices.
        notes = remoteNotes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        localStorage.setItem(notesKey, JSON.stringify(notes));
      }
    } catch (error) {
       console.warn("Sync failed or offline, using local cache.", error);
    }
  }

  return notes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

export const saveNote = async (note: Note, userId?: string | null) => {
  const { uid, isGuest, notesKey } = getUserContext(userId);

  // 1. Update Local Cache
  const localData = localStorage.getItem(notesKey);
  let currentNotes: Note[] = localData ? JSON.parse(localData).map((n: any) => ({ ...n, createdAt: new Date(n.createdAt) })) : [];
  const index = currentNotes.findIndex(n => n.id === note.id);
  if (index >= 0) currentNotes[index] = note;
  else currentNotes = [note, ...currentNotes];
  localStorage.setItem(notesKey, JSON.stringify(currentNotes));

  // 2. Update Cloud
  if (!isGuest && uid) {
      try {
          const noteRef = doc(db, 'users', uid, 'notes', note.id);
          const firestoreData = { ...note, createdAt: Timestamp.fromDate(note.createdAt) };
          await setDoc(noteRef, firestoreData);
      } catch (e) { console.error("Cloud save failed", e); }
  }
};

export const deleteNoteById = async (id: string, userId?: string | null) => {
    const { uid, isGuest, notesKey } = getUserContext(userId);

    // 1. Update Local
    const localData = localStorage.getItem(notesKey);
    if (localData) {
        const parsed = JSON.parse(localData);
        const filtered = parsed.filter((n: any) => n.id !== id);
        localStorage.setItem(notesKey, JSON.stringify(filtered));
    }

    // 2. Update Cloud
    if (!isGuest && uid) {
        try {
            const noteRef = doc(db, 'users', uid, 'notes', id);
            await deleteDoc(noteRef);
        } catch (e) { console.error("Cloud delete failed", e); }
    }
};

// --- USAGE & STATS ---

const DEFAULT_STATS: UsageStats = {
    count: 0,
    weekStart: getWeekStart(), // Resets every Sunday
    isPremium: false
};

export const getUserStats = async (userId?: string | null): Promise<UsageStats> => {
    const { uid, isGuest, statsKey } = getUserContext(userId);
    const currentWeekStart = getWeekStart();

    let stats = DEFAULT_STATS;

    // 1. Load Local
    const localData = localStorage.getItem(statsKey);
    if (localData) {
        const parsed = JSON.parse(localData);
        // Auto-Reset if week has changed
        if (parsed.weekStart !== currentWeekStart) {
            stats = { ...parsed, count: 0, weekStart: currentWeekStart };
            localStorage.setItem(statsKey, JSON.stringify(stats));
        } else {
            stats = parsed;
        }
    }

    // 2. Sync Remote (Source of Truth for Logged In Users)
    if (!isGuest && uid) {
        try {
            const statsRef = doc(db, 'users', uid, 'settings', 'stats');
            const snap = await withTimeout(getDoc(statsRef)) as DocumentSnapshot<DocumentData>;
            
            if (snap.exists()) {
                const remoteData = snap.data() as UsageStats;
                
                // Check week remotely
                if (remoteData.weekStart !== currentWeekStart) {
                     // Week changed since last remote sync -> Reset Remote
                     const newStats = { ...remoteData, count: 0, weekStart: currentWeekStart };
                     await setDoc(statsRef, newStats, { merge: true });
                     stats = newStats;
                } else {
                     stats = remoteData;
                }
                // Update local to match remote
                localStorage.setItem(statsKey, JSON.stringify(stats));
            } else {
                // Initialize remote if missing
                await setDoc(statsRef, stats);
            }
        } catch (e) {
            console.warn("Stats sync failed", e);
        }
    }

    return stats;
};

export const incrementUsage = async (userId?: string | null) => {
    const { uid, isGuest, statsKey } = getUserContext(userId);
    
    // Fetch latest to ensure we are incrementing correct week/count
    const stats = await getUserStats(uid); 
    const newStats = { ...stats, count: stats.count + 1 };
    
    // Update Local
    localStorage.setItem(statsKey, JSON.stringify(newStats));

    // Update Remote
    if (!isGuest && uid) {
        try {
            const statsRef = doc(db, 'users', uid, 'settings', 'stats');
            await setDoc(statsRef, newStats, { merge: true });
        } catch (e) {}
    }
};

export const setPremiumStatus = async (isPremium: boolean, userId?: string | null) => {
    const { uid, isGuest, statsKey } = getUserContext(userId);
    const stats = await getUserStats(uid);
    const newStats = { ...stats, isPremium };
    
    localStorage.setItem(statsKey, JSON.stringify(newStats));
    
    if (!isGuest && uid) {
        try {
             const statsRef = doc(db, 'users', uid, 'settings', 'stats');
             await setDoc(statsRef, newStats, { merge: true });
        } catch (e) {}
    }
};