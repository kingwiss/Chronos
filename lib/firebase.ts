import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA4ByiS0b30B5-zgGpddeivrf1LG9_VRlw",
  authDomain: "cronos-61d1d.firebaseapp.com",
  projectId: "cronos-61d1d",
  storageBucket: "cronos-61d1d.firebasestorage.app",
  messagingSenderId: "487109453894",
  appId: "1:487109453894:web:f59ef0fd72b6e80bf00247",
  measurementId: "G-PD08C94Y9Z"
};

// Initialize Firebase
// We use a try-catch to handle cases where config is missing in dev environment
let app, auth, db;
try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (e) {
    console.warn("Firebase not initialized. Ensure valid config in lib/firebase.ts");
}

export { app, auth, db };