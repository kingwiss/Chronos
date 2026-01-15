import React, { useState } from 'react';
import { auth } from '../lib/firebase';
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { X, Mail, Loader2, LogIn, User, Lock, KeyRound } from 'lucide-react';

interface AuthModalProps {
  onClose: () => void;
  onSuccess: () => void;
  isDarkMode: boolean;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onClose, onSuccess, isDarkMode }) => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleGoogleAuth = async () => {
    if (!auth) {
        setError("Firebase configuration missing.");
        return;
    }
    setIsLoading(true);
    setError('');
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/invalid-credential') {
          setError('Access denied. Domain may not be authorized in Firebase Console.');
      } else {
          setError(err.message || 'Failed to sign in with Google');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth) {
        setError("Firebase configuration missing.");
        return;
    }

    // Validation
    if (isSignUp) {
        if (!username.trim()) {
            setError("Username is required.");
            return;
        }
        if (password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }
        if (password.length < 8) {
            setError("Password must be at least 8 characters.");
            return;
        }
        if (!/[^A-Za-z0-9]/.test(password)) {
            setError("Password must include at least one special character.");
            return;
        }
    }

    setIsLoading(true);
    setError('');
    
    try {
      if (isSignUp) {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        // Update Profile with Username
        if (userCredential.user) {
            await updateProfile(userCredential.user, {
                displayName: username
            });
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error(err);
      let msg = 'Authentication failed';
      if (err.code === 'auth/invalid-credential') msg = 'Invalid email or password.';
      if (err.code === 'auth/email-already-in-use') msg = 'Email already in use.';
      if (err.code === 'auth/weak-password') msg = 'Password should be at least 6 characters.';
      if (err.code === 'auth/user-not-found') msg = 'Account not found.';
      if (err.code === 'auth/wrong-password') msg = 'Incorrect password.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
      setIsSignUp(!isSignUp);
      setError('');
      setPassword('');
      setConfirmPassword('');
      setUsername('');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className={`w-full max-w-sm p-8 rounded-3xl relative shadow-2xl ${isDarkMode ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'}`}>
        <button onClick={onClose} className={`absolute top-4 right-4 ${isDarkMode ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}>
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/30">
             <LogIn className="text-white w-8 h-8" />
          </div>
          <h2 className={`text-2xl font-bold ${isDarkMode ? 'text-white' : 'text-zinc-900'}`}>
            {isSignUp ? 'Create Account' : 'Welcome Back'}
          </h2>
          <p className={`text-sm mt-2 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
            Sign in to sync your notes across devices.
          </p>
        </div>

        {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-500 text-sm p-3 rounded-lg mb-4 text-center">
                {error}
            </div>
        )}

        <div className="space-y-4">
           <button 
             onClick={handleGoogleAuth}
             disabled={isLoading}
             className={`w-full py-3 px-4 rounded-xl font-medium flex items-center justify-center gap-2 transition-all ${isDarkMode ? 'bg-white text-black hover:bg-zinc-200' : 'bg-zinc-900 text-white hover:bg-zinc-800'}`}
           >
             {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                 <>
                   <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" /><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.84z" /><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
                   <span>Continue with Google</span>
                 </>
             )}
           </button>

           <div className="relative flex items-center py-2">
             <div className={`flex-grow border-t ${isDarkMode ? 'border-zinc-800' : 'border-zinc-200'}`}></div>
             <span className={`flex-shrink-0 mx-4 text-xs ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>OR</span>
             <div className={`flex-grow border-t ${isDarkMode ? 'border-zinc-800' : 'border-zinc-200'}`}></div>
           </div>

           <form onSubmit={handleEmailAuth} className="space-y-3">
              {isSignUp && (
                  <div className="relative animate-in fade-in slide-in-from-top-2">
                     <User className={`absolute left-3 top-3 w-5 h-5 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`} />
                     <input 
                       type="text" 
                       placeholder="Username" 
                       value={username}
                       onChange={e => setUsername(e.target.value)}
                       className={`w-full pl-10 pr-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${isDarkMode ? 'bg-zinc-800 text-white placeholder-zinc-600' : 'bg-zinc-100 text-zinc-900 placeholder-zinc-400'}`}
                       required={isSignUp}
                     />
                  </div>
              )}
              
              <div className="relative">
                 <Mail className={`absolute left-3 top-3 w-5 h-5 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`} />
                 <input 
                   type="email" 
                   placeholder="Email address" 
                   value={email}
                   onChange={e => setEmail(e.target.value)}
                   className={`w-full pl-10 pr-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${isDarkMode ? 'bg-zinc-800 text-white placeholder-zinc-600' : 'bg-zinc-100 text-zinc-900 placeholder-zinc-400'}`}
                   required
                 />
              </div>

              <div className="relative">
                 <Lock className={`absolute left-3 top-3 w-5 h-5 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`} />
                 <input 
                   type="password" 
                   placeholder="Password" 
                   value={password}
                   onChange={e => setPassword(e.target.value)}
                   className={`w-full pl-10 pr-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${isDarkMode ? 'bg-zinc-800 text-white placeholder-zinc-600' : 'bg-zinc-100 text-zinc-900 placeholder-zinc-400'}`}
                   required
                 />
              </div>

              {isSignUp && (
                  <div className="relative animate-in fade-in slide-in-from-top-2">
                     <KeyRound className={`absolute left-3 top-3 w-5 h-5 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`} />
                     <input 
                       type="password" 
                       placeholder="Confirm Password" 
                       value={confirmPassword}
                       onChange={e => setConfirmPassword(e.target.value)}
                       className={`w-full pl-10 pr-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${isDarkMode ? 'bg-zinc-800 text-white placeholder-zinc-600' : 'bg-zinc-100 text-zinc-900 placeholder-zinc-400'}`}
                       required={isSignUp}
                     />
                  </div>
              )}

              <button 
                type="submit" 
                disabled={isLoading}
                className={`w-full py-3 rounded-xl font-bold transition-all ${isDarkMode ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-900'}`}
              >
                 {isLoading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : (isSignUp ? 'Create Account' : 'Sign In')}
              </button>
           </form>

           <p className={`text-center text-sm ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {isSignUp ? "Already have an account?" : "Don't have an account?"}
              <button onClick={toggleMode} className="ml-1 text-indigo-500 hover:underline font-medium">
                 {isSignUp ? "Sign In" : "Sign Up"}
              </button>
           </p>
        </div>
      </div>
    </div>
  );
};