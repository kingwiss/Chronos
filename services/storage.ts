import { db, auth } from '../lib/firebase';
import { collection, updateDoc, deleteDoc, doc, query, where, getDocs, setDoc, getDoc, Timestamp, QuerySnapshot, DocumentSnapshot, DocumentData } from 'firebase/firestore';
import { Note } from '../types';

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
  d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
  return d.toISOString();
};

// --- KEY GENERATORS ---
// Dynamically generate storage keys based on the current user UID
// This ensures that User A sees only User A's data, User B sees User B's, and Guests see Guest data.
const getUserId = () => auth.currentUser?.uid || 'guest';

const getNotesKey = () => `chronos_notes_${getUserId()}`;
const getStatsKey = () => `chronos_stats_${getUserId()}`;

// --- STORAGE FUNCTIONS ---

export const getNotes = async (): Promise<Note[]> => {
  const uid = auth.currentUser?.uid;
  const localKey = getNotesKey();
  
  // 1. Load Local Cache First (Instant Render)
  // This uses the dynamic key, so it will only load data for the currently logged-in user (or guest)
  const localData = localStorage.getItem(localKey);
  let notes: Note[] = [];
  
  if (localData) {
      try {
          const parsed = JSON.parse(localData);
          notes = parsed.map((n: any) => ({
              ...n,
              createdAt: new Date(n.createdAt),
              // Restore dates in nested objects if necessary
              alarm: n.alarm ? { ...n.alarm } : undefined
          }));
      } catch (e) {
          console.error("Failed to parse local notes", e);
      }
  }

  // 2. If User is Logged In, Sync with Cloud
  if (uid) {
    try {
      // Use subcollection for strict isolation: users/{uid}/notes
      const notesRef = collection(db, 'users', uid, 'notes');
      
      // Use timeout to prevent hanging if offline
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

        // Merge/Sort logic: Remote is truth for authenticated users
        notes = remoteNotes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        
        // Update Local Cache with specific user key so next refresh is fast
        localStorage.setItem(localKey, JSON.stringify(notes));
      }
    } catch (error) {
       console.warn("Sync failed or offline, using local cache.", error);
    }
  }

  return notes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

export const saveNote = async (note: Note) => {
  const uid = auth.currentUser?.uid;
  const localKey = getNotesKey();

  // 1. Update Local Cache (Optimistic UI)
  // We re-fetch here to ensure we are appending to the correct list in memory
  const localData = localStorage.getItem(localKey);
  let currentNotes: Note[] = localData ? JSON.parse(localData).map((n: any) => ({ ...n, createdAt: new Date(n.createdAt) })) : [];

  const index = currentNotes.findIndex(n => n.id === note.id);
  
  if (index >= 0) {
      currentNotes[index] = note;
  } else {
      currentNotes = [note, ...currentNotes];
  }
  
  localStorage.setItem(localKey, JSON.stringify(currentNotes));

  // 2. Update Cloud if Logged In
  if (uid) {
      try {
          const noteRef = doc(db, 'users', uid, 'notes', note.id);
          // Convert Dates to Timestamps for Firestore
          const firestoreData = {
              ...note,
              createdAt: Timestamp.fromDate(note.createdAt)
          };
          await setDoc(noteRef, firestoreData);
      } catch (e) {
          console.error("Cloud save failed", e);
      }
  }
};

export const deleteNoteById = async (id: string) => {
    const uid = auth.currentUser?.uid;
    const localKey = getNotesKey();

    // 1. Update Local
    const localData = localStorage.getItem(localKey);
    if (localData) {
        const parsed = JSON.parse(localData);
        const filtered = parsed.filter((n: any) => n.id !== id);
        localStorage.setItem(localKey, JSON.stringify(filtered));
    }

    // 2. Update Cloud
    if (uid) {
        try {
            const noteRef = doc(db, 'users', uid, 'notes', id);
            await deleteDoc(noteRef);
        } catch (e) {
            console.error("Cloud delete failed", e);
        }
    }
};

// --- USAGE & STATS ---

const DEFAULT_STATS: UsageStats = {
    count: 0,
    weekStart: getWeekStart(),
    isPremium: false
};

export const getUserStats = async (): Promise<UsageStats> => {
    const uid = auth.currentUser?.uid;
    const localKey = getStatsKey();
    const currentWeekStart = getWeekStart();

    let stats = DEFAULT_STATS;

    // Load Local
    const localData = localStorage.getItem(localKey);
    if (localData) {
        const parsed = JSON.parse(localData);
        // Reset if week changed
        if (parsed.weekStart !== currentWeekStart) {
            stats = { ...parsed, count: 0, weekStart: currentWeekStart };
            localStorage.setItem(localKey, JSON.stringify(stats));
        } else {
            stats = parsed;
        }
    }

    // Sync Remote
    if (uid) {
        try {
            const statsRef = doc(db, 'users', uid, 'settings', 'stats');
            const snap = await withTimeout(getDoc(statsRef)) as DocumentSnapshot<DocumentData>;
            
            if (snap.exists()) {
                const remoteData = snap.data() as UsageStats;
                // Check week remotely
                if (remoteData.weekStart !== currentWeekStart) {
                     // Reset remote
                     const newStats = { ...remoteData, count: 0, weekStart: currentWeekStart };
                     await setDoc(statsRef, newStats, { merge: true });
                     stats = newStats;
                } else {
                     stats = remoteData;
                }
                // Update local
                localStorage.setItem(localKey, JSON.stringify(stats));
            } else {
                // If remote document doesn't exist yet, initialize it
                await setDoc(statsRef, stats);
            }
        } catch (e) {
            console.warn("Stats sync failed", e);
        }
    }

    return stats;
};

export const incrementUsage = async () => {
    const stats = await getUserStats();
    const newStats = { ...stats, count: stats.count + 1 };
    
    // Update Local
    localStorage.setItem(getStatsKey(), JSON.stringify(newStats));

    // Update Remote
    const uid = auth.currentUser?.uid;
    if (uid) {
        try {
            const statsRef = doc(db, 'users', uid, 'settings', 'stats');
            await setDoc(statsRef, newStats, { merge: true });
        } catch (e) {}
    }
};

export const setPremiumStatus = async (isPremium: boolean) => {
    const stats = await getUserStats();
    const newStats = { ...stats, isPremium };
    
    // Update Local
    localStorage.setItem(getStatsKey(), JSON.stringify(newStats));
    
    // Update Remote
    const uid = auth.currentUser?.uid;
    if (uid) {
        try {
             const statsRef = doc(db, 'users', uid, 'settings', 'stats');
             await setDoc(statsRef, newStats, { merge: true });
        } catch (e) {}
    }
};