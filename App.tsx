import React, { useState, useEffect, useRef } from 'react';
import { Camera, Mic, Activity, X, BellRing, Image as ImageIcon, RefreshCcw, Plus, Check, Clock, Footprints, Utensils, Timer, Zap, ChevronLeft, Sparkles, Moon, Sun, User as UserIcon, LogOut, Crown, Loader2 } from 'lucide-react';
import { Note, NoteType, DraftData } from './types';
import { NoteCard } from './components/NoteCard';
import { VoiceAgent } from './components/VoiceAgent';
import { NoteMakerModal } from './components/NoteMakerModal';
import { CalendarView } from './components/CalendarView';
import { processMultiModalInput, generateNoteImage } from './services/geminiService';
import { auth } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { getNotes, saveNote, deleteNoteById, getUserStats, incrementUsage } from './services/storage';
import { AuthModal } from './components/AuthModal';
import { PremiumModal } from './components/PremiumModal';

const App: React.FC = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [pendingAttachment, setPendingAttachment] = useState<string | null>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  
  // Theme State
  const [isDarkMode, setIsDarkMode] = useState(true);

  // User & Auth State
  const [user, setUser] = useState<any>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [showPremiumModal, setShowPremiumModal] = useState(false);
  const [isPremium, setIsPremium] = useState(false);
  const [usageCount, setUsageCount] = useState(0);

  // Note Maker State
  const [showNoteMaker, setShowNoteMaker] = useState(false);

  // Speed Dial State
  const [showSpeedDial, setShowSpeedDial] = useState(false);
  const [showGlobalVoiceAgent, setShowGlobalVoiceAgent] = useState(false);

  // Camera & Attachment UI State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraFacingMode, setCameraFacingMode] = useState<'user' | 'environment'>('environment');
  const [cameraMode, setCameraMode] = useState<NoteType>(NoteType.MEMO);
  
  // Navigation State
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const [showSwipeHint, setShowSwipeHint] = useState(false);
  
  // Refs
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Alarm State
  const [ringingAlarm, setRingingAlarm] = useState<Note | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const alarmIntervalRef = useRef<number | null>(null);

  // --- INITIALIZATION ---

  useEffect(() => {
    let unsubscribe = () => {};
    if (auth) {
        unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            // Strict Isolation: Show loader and clear notes immediately when switching users
            setIsAuthLoading(true);
            setNotes([]); 
            
            setUser(currentUser);
            await loadData();
            setIsAuthLoading(false);
        });
    } else {
        loadData().then(() => setIsAuthLoading(false));
    }

    const savedTheme = localStorage.getItem('chronos_theme');
    if (savedTheme) {
        setIsDarkMode(savedTheme === 'dark');
    }

    return () => unsubscribe();
  }, []);

  const loadData = async () => {
      const fetchedNotes = await getNotes();
      if (fetchedNotes.length === 0 && !auth?.currentUser) {
          const welcomeNote: Note = {
            id: 'init',
            createdAt: new Date(),
            type: NoteType.MEMO,
            content: 'Welcome to Chronos! I can track your nutrition from photos, set alarms, log steps, and keep your memos organized. Try uploading a photo of your lunch or typing "Wake me up at 7am".'
          };
          setNotes([welcomeNote]);
          saveNote(welcomeNote);
      } else {
          setNotes(fetchedNotes);
      }
      const stats = await getUserStats();
      setIsPremium(stats.isPremium);
      setUsageCount(stats.count);
  };

  useEffect(() => {
    localStorage.setItem('chronos_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const attemptSmartFeature = async (): Promise<boolean> => {
      // 1. Get latest stats
      const stats = await getUserStats();
      setIsPremium(stats.isPremium);
      setUsageCount(stats.count);

      // 2. If Premium, allow everything
      if (stats.isPremium) return true;

      // 3. Check Limit (10 per week)
      if (stats.count >= 10) {
          if (!user) {
              // Guest hit limit -> Must Log In
              setAuthMessage("You've reached your weekly limit of 10 smart actions. Log in to upgrade to Premium for unlimited access.");
              setShowAuthModal(true);
          } else {
              // User hit limit -> Must Pay
              setShowPremiumModal(true);
          }
          return false;
      }

      // 4. Increment and Allow
      await incrementUsage();
      setUsageCount(prev => prev + 1);
      return true;
  };

  const handleAuthSuccess = async () => {
      await loadData();
      setShowAuthModal(false);
      
      // If user logged in because they hit a limit, check if they need to pay
      if (authMessage) {
          setAuthMessage('');
          const stats = await getUserStats();
          if (!stats.isPremium) {
              // Prompt upgrade immediately if they are still free tier
              setShowPremiumModal(true);
          }
      }
  };

  useEffect(() => {
    const scrollToTimeline = () => {
        if (pageContainerRef.current) {
            pageContainerRef.current.scrollLeft = pageContainerRef.current.clientWidth;
        }
    };
    if (!isAuthLoading) {
        scrollToTimeline();
        const frameId = requestAnimationFrame(() => {
            scrollToTimeline();
            setTimeout(() => setShowSwipeHint(true), 1000);
            setTimeout(() => setShowSwipeHint(false), 5000);
        });
        return () => cancelAnimationFrame(frameId);
    }
  }, [isAuthLoading]);

  useEffect(() => {
    const hintInterval = setInterval(() => {
        if (pageContainerRef.current) {
            const { scrollLeft, clientWidth } = pageContainerRef.current;
            const isAtTimeline = Math.abs(scrollLeft - clientWidth) < 50; 
            if (isAtTimeline) {
                setShowSwipeHint(true);
                setTimeout(() => setShowSwipeHint(false), 4000);
            }
        }
    }, 20000);
    return () => clearInterval(hintInterval);
  }, []);

  const handleContainerScroll = () => {
      if (showSwipeHint) setShowSwipeHint(false);
  };

  const handleDateSelect = (date: Date) => {
    if (pageContainerRef.current) {
        pageContainerRef.current.scrollTo({ left: pageContainerRef.current.clientWidth, behavior: 'smooth' });
    }
    const targetId = `date-${date.toDateString()}`;
    setTimeout(() => {
        const element = document.getElementById(targetId);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 500); 
  };

  useEffect(() => {
    if (isCameraOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [isCameraOpen, cameraFacingMode]);

  const startCamera = async () => {
    try {
      if (cameraStreamRef.current) stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: cameraFacingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Failed to access camera", err);
      alert("Could not access camera. Please check permissions.");
      setIsCameraOpen(false);
    }
  };

  const stopCamera = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
    }
  };

  const capturePhoto = () => {
    if (cameraVideoRef.current) {
      const video = cameraVideoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        if (cameraFacingMode === 'user') {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0);
        const base64String = canvas.toDataURL('image/jpeg', 0.8);
        const base64Data = base64String.split(',')[1];
        setPendingAttachment(base64Data);
        setIsCameraOpen(false);
        if (!showNoteMaker) {
            setShowNoteMaker(true);
        }
      }
    }
  };

  const toggleCameraFacing = () => {
    setCameraFacingMode(prev => prev === 'user' ? 'environment' : 'user');
  };
  
  const handleCameraGalleryClick = () => {
      if (fileInputRef.current) fileInputRef.current.click();
  };

  const startAlarmSound = () => {
    try {
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'closed') {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AudioContextClass();
      }
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); 
      
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.5, now + 0.1);
      gain.gain.linearRampToValueAtTime(0.5, now + 0.5);
      gain.gain.linearRampToValueAtTime(0.5, now + 0.6);
      gain.gain.linearRampToValueAtTime(0.5, now + 1.0);
      osc.start();
      oscillatorRef.current = osc;
    } catch (e) {
      console.error("Audio play failed", e);
    }
  };

  const stopAlarmSound = () => {
    if (oscillatorRef.current) {
      try { oscillatorRef.current.stop(); oscillatorRef.current.disconnect(); } catch (e) {}
      oscillatorRef.current = null;
    }
    if (alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'running') {
        audioCtxRef.current.suspend();
    }
  };

  const handleDismissAlarm = () => {
    setRingingAlarm(null);
    stopAlarmSound();
  };

  useEffect(() => {
    const checkAlarms = () => {
      if (ringingAlarm) return;
      const now = new Date();

      const alarmToRing = notes.find(note => {
        if ((note.type === NoteType.ALARM || note.type === NoteType.TIMER) && note.alarm && !note.alarm.fired) {
          const alarmDate = new Date(note.alarm.time);
          if (!isNaN(alarmDate.getTime())) return now >= alarmDate;
        }
        return false;
      });

      if (alarmToRing) {
        setRingingAlarm(alarmToRing);
        const updated = { ...alarmToRing, alarm: { ...alarmToRing.alarm!, fired: true } };
        setNotes(prev => prev.map(n => n.id === updated.id ? updated : n));
        saveNote(updated);

        startAlarmSound();
        alarmIntervalRef.current = window.setInterval(startAlarmSound, 1500);
      }
    };
    const intervalId = setInterval(checkAlarms, 1000); 
    return () => clearInterval(intervalId);
  }, [notes, ringingAlarm]);

  const addNoteInternal = async (note: Note) => {
    setNotes(prev => [note, ...prev]);
    await saveNote(note);
  };

  const updateNoteInternal = async (updatedNote: Note) => {
    setNotes(prev => prev.map(n => n.id === updatedNote.id ? updatedNote : n));
    await saveNote(updatedNote);
  };

  const deleteNoteInternal = async (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
    await deleteNoteById(id);
  };

  const handleSmartUpdate = async (id: string, newText: string) => {
    const allowed = await attemptSmartFeature();
    
    // Fallback: If limit reached, still allow saving the text edit!
    if (!allowed) {
        const existing = notes.find(n => n.id === id);
        if (existing) {
             await updateNoteInternal({ ...existing, content: newText });
        }
        return;
    }

    const existing = notes.find(n => n.id === id);
    if (!existing) return;

    try {
      const result = await processMultiModalInput(newText);
      let newImageUrl = existing.imageUrl;
      let isAiGenerated = existing.isAiImage;

      if (!existing.imageUrl || existing.isAiImage) {
          const prompt = result.visualDescription || result.content;
          const genImage = await generateNoteImage(prompt);
          if (genImage) {
              newImageUrl = `data:image/jpeg;base64,${genImage}`;
              isAiGenerated = true;
          }
      }
      
      const updated: Note = {
        ...existing,
        type: result.type,
        content: result.content,
        imageUrl: newImageUrl,
        isAiImage: isAiGenerated,
        alarm: (result.type === NoteType.ALARM || result.type === NoteType.TIMER) 
            ? { time: result.alarmTime || new Date().toISOString(), label: result.alarmLabel || result.content } 
            : undefined,
        steps: result.type === NoteType.STEPS 
            ? { count: result.steps || 0 } 
            : (result.type === NoteType.STEPS_TRACKER ? { count: existing.steps?.count || 0, isLive: true } : undefined),
        nutrition: result.type === NoteType.NUTRITION ? (result.nutrition || existing.nutrition) : undefined
      };

      await updateNoteInternal(updated);
    } catch (e) {
      console.error("Smart update failed", e);
      await updateNoteInternal({ ...existing, content: newText });
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        const base64Data = base64String.split(',')[1]; 
        setPendingAttachment(base64Data);
        setIsCameraOpen(false); 
        setShowNoteMaker(true);
      };
      reader.readAsDataURL(file);
    } catch (error) {
       console.error(error);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleNoteMakerSave = async (draft: DraftData) => {
    // 1. Prepare basics
    const tempId = crypto.randomUUID();
    const createdAt = new Date();
    
    // Construct initial note for immediate display (Optimistic UI)
    const initialNote: Note = {
        id: tempId,
        createdAt,
        type: draft.type,
        content: draft.content,
        imageUrl: pendingAttachment ? `data:image/jpeg;base64,${pendingAttachment}` : undefined,
        isAiImage: false,
        alarm: draft.alarmTime ? { time: draft.alarmTime, label: draft.content } : undefined,
        steps: draft.stepsCount ? { count: draft.stepsCount } : undefined,
        nutrition: draft.nutritionData
    };

    // Handle empty content or analyzing state
    if (!initialNote.content && pendingAttachment) {
        initialNote.content = "Analyzing image...";
    } else if (!initialNote.content) {
        initialNote.content = "New Note";
    }

    // 2. Render Immediately (Unblock UI)
    await addNoteInternal(initialNote);
    
    // Reset UI states immediately
    setPendingAttachment(null);
    setCameraMode(NoteType.MEMO);

    // 3. Background Processing (Fire and Forget)
    (async () => {
        try {
            // If explicit type was set manually (not MEMO), we usually don't need AI classification
            // unless there is an image attachment that needs analysis (e.g. food)
            const isManualType = draft.type !== NoteType.MEMO;
            
            // Skip smart features if manually typed and no attachment, unless premium
            if (!pendingAttachment && isManualType) return;

            const allowed = await attemptSmartFeature();
            if (!allowed) return;

            let updatedNote = { ...initialNote };
            let processingResult: any = null;
            let needsUpdate = false;

            // A. Classification / Analysis
            // Run if it's a generic MEMO or has an attachment
            if (draft.type === NoteType.MEMO || pendingAttachment) {
                 let promptText = draft.content;
                 if (!promptText && cameraMode === NoteType.NUTRITION) {
                     promptText = "Analyze this food image and provide nutrition data.";
                 }
                 
                 processingResult = await processMultiModalInput(promptText, pendingAttachment || undefined);
                 
                 // Update note object with AI results
                 updatedNote.type = processingResult.type;
                 updatedNote.content = processingResult.content;
                 
                 if (processingResult.type === NoteType.ALARM || processingResult.type === NoteType.TIMER) {
                     updatedNote.alarm = { 
                         time: processingResult.alarmTime || '', 
                         label: processingResult.alarmLabel || processingResult.content 
                     };
                 } else if (processingResult.type === NoteType.STEPS) {
                     updatedNote.steps = { count: processingResult.steps || 0 };
                 } else if (processingResult.type === NoteType.NUTRITION) {
                     updatedNote.nutrition = processingResult.nutrition;
                 }
                 
                 needsUpdate = true;
            }

            // A2. Apply updates from classification
            if (needsUpdate) {
                await updateNoteInternal({ ...updatedNote });
            }

            // B. Image Generation
            // Generate if no image exists AND we have content/description
            if (!updatedNote.imageUrl) {
                const prompt = processingResult?.visualDescription || updatedNote.content;
                
                // Only generate if we have a valid prompt and it's not just a short command
                if (prompt && prompt.length > 3) {
                    const genImage = await generateNoteImage(prompt);
                    if (genImage) {
                        updatedNote.imageUrl = `data:image/jpeg;base64,${genImage}`;
                        updatedNote.isAiImage = true;
                        await updateNoteInternal({ ...updatedNote });
                    }
                }
            }
        } catch (error) {
            console.error("Background processing error:", error);
            if (initialNote.content === "Analyzing image...") {
                updateNoteInternal({ ...initialNote, content: "Processing failed." });
            }
        }
    })();
  };

  const handleVoiceNoteCreation = async (data: any) => {
    const type = data.type as NoteType || NoteType.MEMO;
    let aiImage = undefined;
    
    const allowed = await attemptSmartFeature();
    if (!allowed) return;

    const prompt = data.visualDescription || data.content;
    
    if (prompt) {
       const gen = await generateNoteImage(prompt);
       if (gen) aiImage = `data:image/jpeg;base64,${gen}`;
    }

    let noteData: Partial<Note> = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      type: type,
      content: data.content,
      imageUrl: aiImage,
      isAiImage: !!aiImage
    };

    if ((type === NoteType.ALARM || type === NoteType.TIMER) && data.alarmTime) {
      noteData.alarm = { time: data.alarmTime, label: data.content };
    } else if (type === NoteType.STEPS && data.stepsCount) {
      noteData.steps = { count: Number(data.stepsCount) };
    } else if (type === NoteType.STEPS_TRACKER) {
      noteData.steps = { count: 0, isLive: true };
    } else if (type === NoteType.NUTRITION && data.nutritionData) {
      noteData.nutrition = data.nutritionData;
    }
    await addNoteInternal(noteData as Note);
  };

  const handleVoiceNoteEdit = async (id: string, newContent: string) => {
    handleSmartUpdate(id, newContent);
  };

  const handleVoiceNoteDelete = async (id: string) => {
    await deleteNoteInternal(id);
  };

  const handleShortcutSteps = async () => {
      const allowed = await attemptSmartFeature();
      if (!allowed) return;
      addNoteInternal({
          id: crypto.randomUUID(),
          createdAt: new Date(),
          type: NoteType.STEPS_TRACKER,
          content: "Live Step Counter Started",
          steps: { count: 0, isLive: true }
      });
      setShowSpeedDial(false);
  };

  const handleShortcutAlarm = () => {
      setShowNoteMaker(true);
      setShowSpeedDial(false);
  };

  const handleShortcutNutrition = async () => {
      const allowed = await attemptSmartFeature();
      if (!allowed) return;
      setCameraMode(NoteType.NUTRITION);
      setIsCameraOpen(true);
      setShowSpeedDial(false);
  };

  if (isAuthLoading) {
      return (
          <div className={`h-screen w-full flex items-center justify-center flex-col gap-4 ${isDarkMode ? 'bg-zinc-950 text-white' : 'bg-zinc-50 text-zinc-900'}`}>
              <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
              <div className="text-sm font-medium opacity-50">Initializing Chronos...</div>
          </div>
      );
  }

  return (
    <div className={`h-screen font-sans flex flex-col relative overflow-hidden transition-colors duration-500 ${isDarkMode ? 'bg-zinc-950 text-white' : 'bg-zinc-50 text-zinc-900'}`}>
      
      <div className={`absolute top-[-20%] left-[-20%] w-[80%] h-[80%] rounded-full blur-[120px] pointer-events-none opacity-20 animate-pulse-slow ${isDarkMode ? 'bg-indigo-900' : 'bg-indigo-200'}`}></div>
      <div className={`absolute bottom-[-20%] right-[-20%] w-[80%] h-[80%] rounded-full blur-[120px] pointer-events-none opacity-20 animate-pulse-slow ${isDarkMode ? 'bg-purple-900' : 'bg-purple-200'}`} style={{ animationDelay: '1.5s' }}></div>

      <input 
        type="file" 
        ref={fileInputRef}
        className="hidden" 
        style={{ display: 'none' }}
        accept="image/*"
        onChange={handleImageSelect}
      />

      {showAuthModal && (
        <AuthModal 
          onClose={() => { setShowAuthModal(false); setAuthMessage(''); }} 
          onSuccess={handleAuthSuccess} 
          isDarkMode={isDarkMode} 
          message={authMessage}
        />
      )}
      
      {showPremiumModal && <PremiumModal onClose={() => setShowPremiumModal(false)} onSuccess={loadData} isDarkMode={isDarkMode} />}

      {ringingAlarm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-xl animate-in fade-in">
           <div className={`bg-zinc-900 border ${ringingAlarm.type === NoteType.TIMER ? 'border-pink-500/50 shadow-pink-900/40' : 'border-red-500/50 shadow-red-900/40'} p-8 rounded-3xl flex flex-col items-center gap-6 max-w-sm w-full shadow-2xl relative overflow-hidden`}>
              <div className={`absolute inset-0 ${ringingAlarm.type === NoteType.TIMER ? 'bg-pink-500/10' : 'bg-red-500/10'} animate-pulse`}></div>
              <div className={`relative z-10 ${ringingAlarm.type === NoteType.TIMER ? 'bg-pink-500/20' : 'bg-red-500/20'} p-6 rounded-full`}>
                 {ringingAlarm.type === NoteType.TIMER ? (
                    <Timer className="w-16 h-16 text-pink-500 animate-[wiggle_1s_ease-in-out_infinite]" />
                 ) : (
                    <BellRing className="w-16 h-16 text-red-500 animate-[wiggle_1s_ease-in-out_infinite]" />
                 )}
              </div>
              <div className="relative z-10 text-center">
                 {ringingAlarm.type === NoteType.TIMER ? (
                    <h2 className="text-3xl font-black text-white">Time's Up!</h2>
                 ) : (
                    <h2 className="text-3xl font-black text-white">{ringingAlarm.alarm?.time ? new Date(ringingAlarm.alarm.time).toLocaleTimeString() : ''}</h2>
                 )}
                 <p className={`${ringingAlarm.type === NoteType.TIMER ? 'text-pink-300' : 'text-red-300'} mt-2 text-lg font-medium`}>{ringingAlarm.alarm?.label || (ringingAlarm.type === NoteType.TIMER ? 'Timer' : 'Alarm')}</p>
              </div>
              <button onClick={handleDismissAlarm} className="relative z-10 w-full py-4 bg-white text-black font-bold text-xl rounded-xl hover:bg-zinc-200 transition-colors shadow-lg">Dismiss</button>
           </div>
        </div>
      )}

      {isCameraOpen && (
        <div className="fixed inset-0 z-[90] bg-black flex flex-col animate-in fade-in duration-200">
           <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-10">
              <div className="bg-black/40 backdrop-blur-md px-3 py-1 rounded-full text-xs font-mono border border-white/10 text-white">
                 {cameraMode === NoteType.NUTRITION ? 'SCAN FOOD' : 'PHOTO'}
              </div>
              <button onClick={() => setIsCameraOpen(false)} className="p-2 bg-black/40 backdrop-blur-md rounded-full text-white hover:bg-zinc-800 border border-white/10">
                 <X className="w-6 h-6" />
              </button>
           </div>
           
           <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
              <video 
                ref={cameraVideoRef} 
                autoPlay 
                playsInline 
                muted
                className={`w-full h-full object-cover ${cameraFacingMode === 'user' ? '-scale-x-100' : ''}`}
              />
              {cameraMode === NoteType.NUTRITION && (
                 <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="w-64 h-64 border-2 border-orange-500/50 rounded-2xl relative">
                        <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-orange-500"></div>
                        <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-orange-500"></div>
                        <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-orange-500"></div>
                        <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-orange-500"></div>
                    </div>
                 </div>
              )}
           </div>

           <div className="bg-black p-8 pb-12 flex items-center justify-around">
              <div className="w-12 flex justify-center">
                 <button onClick={handleCameraGalleryClick} className="p-3 bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
                    <ImageIcon className="w-6 h-6" />
                 </button>
              </div>
              <button onClick={capturePhoto} className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center group active:scale-95 transition-transform">
                 <div className="w-16 h-16 rounded-full bg-white group-active:scale-90 transition-transform"></div>
              </button>
              <div className="w-12 flex justify-center">
                 <button onClick={toggleCameraFacing} className="p-3 bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
                    <RefreshCcw className="w-6 h-6" />
                 </button>
              </div>
           </div>
        </div>
      )}

      <div 
        ref={pageContainerRef} 
        onScroll={handleContainerScroll}
        className="w-full h-full overflow-x-auto snap-x snap-mandatory flex scroll-smooth no-scrollbar relative z-10"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        <div className="w-full h-full flex-shrink-0 snap-center overflow-y-auto">
            <CalendarView notes={notes} onSelectDate={handleDateSelect} isDarkMode={isDarkMode} />
        </div>

        <div className="w-full h-full flex-shrink-0 snap-center flex flex-col items-center relative" ref={timelineContainerRef}>
            <header className={`w-full max-w-2xl p-4 flex items-center justify-between sticky top-0 z-20 border-b backdrop-blur-lg transition-colors duration-500 ${isDarkMode ? 'bg-zinc-950/80 border-zinc-900' : 'bg-zinc-50/80 border-zinc-200'}`}>
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-900/20">
                        <Activity className="text-white w-6 h-6" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h1 className={`font-bold text-xl tracking-tight ${isDarkMode ? 'text-white' : 'text-zinc-900'}`}>Chronos</h1>
                            {isPremium && <Crown className="w-4 h-4 text-amber-400 fill-amber-400" />}
                        </div>
                        <p className={`text-xs font-medium ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>AI Timeline & Notepad</p>
                    </div>
                </div>
                
                <div className="flex items-center gap-2">
                    {!isPremium && (
                        <button onClick={() => setShowPremiumModal(true)} className="bg-gradient-to-r from-amber-500 to-orange-500 text-white px-3 py-1.5 rounded-full flex items-center gap-1 shadow-lg hover:scale-105 transition-transform">
                            <Crown className="w-3 h-3 fill-white" />
                            <span className="text-xs font-bold uppercase tracking-wider">Premium</span>
                        </button>
                    )}

                    <button onClick={() => setIsDarkMode(!isDarkMode)} className={`p-2 rounded-full transition-all ${isDarkMode ? 'bg-zinc-900 text-zinc-400 hover:text-white' : 'bg-zinc-200 text-zinc-600 hover:text-zinc-900'}`}>
                        {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                    </button>
                    
                    <button onClick={() => { if (user) { if(confirm("Log out?")) auth?.signOut(); } else { setShowAuthModal(true); } }} className={`p-1.5 pr-3 rounded-full flex items-center gap-2 transition-all ${isDarkMode ? 'bg-zinc-900 text-zinc-400 hover:text-white' : 'bg-white text-zinc-600 hover:text-zinc-900 shadow-sm border border-zinc-200'}`}>
                        <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                           {user?.photoURL ? <img src={user.photoURL} alt="User" /> : <UserIcon className="w-4 h-4" />}
                        </div>
                        <span className="text-xs font-medium">{user ? 'Me' : 'Guest'}</span>
                    </button>
                </div>
            </header>

            <main className="flex-1 w-full max-w-2xl p-4 md:p-6 space-y-8 overflow-y-auto pb-32">
                {notes.length === 0 ? (
                <div className={`text-center mt-20 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    <p>No notes yet. Tap the + button to start.</p>
                </div>
                ) : (
                notes.map((note, index) => {
                    const showDate = index === 0 || notes[index - 1].createdAt.getDate() !== note.createdAt.getDate();
                    const dateId = `date-${note.createdAt.toDateString()}`;
                    return (
                    <div key={note.id} className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards" style={{ animationDelay: `${index * 50}ms` }}>
                        {showDate && (
                        <div id={dateId} className="flex items-center gap-4 mb-6 scroll-mt-24">
                            <div className={`h-px flex-1 ${isDarkMode ? 'bg-zinc-800' : 'bg-zinc-200'}`}></div>
                            <span className={`text-xs font-bold uppercase tracking-widest ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                            {note.createdAt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric'})}
                            </span>
                            <div className={`h-px flex-1 ${isDarkMode ? 'bg-zinc-800' : 'bg-zinc-200'}`}></div>
                        </div>
                        )}
                        <div className="flex gap-4">
                        <div className="flex flex-col items-center">
                            <div className="w-2 h-2 rounded-full bg-indigo-500/50 mt-6"></div>
                            <div className={`w-px flex-1 my-2 ${isDarkMode ? 'bg-zinc-800' : 'bg-zinc-200'}`}></div>
                        </div>
                        <div className="flex-1">
                            <NoteCard 
                                note={note} 
                                onUpdate={updateNoteInternal} 
                                onCreate={addNoteInternal}
                                onSmartUpdate={handleSmartUpdate}
                                onDelete={deleteNoteInternal}
                                isDarkMode={isDarkMode}
                                onSmartFeatureAttempt={attemptSmartFeature}
                            />
                        </div>
                        </div>
                    </div>
                    );
                })
                )}
            </main>

            {showSwipeHint && (
               <div className="fixed left-4 top-1/2 -translate-y-1/2 z-30 animate-in fade-in slide-in-from-right-4 duration-700 pointer-events-none">
                  <div className={`backdrop-blur-md text-xs font-bold py-2 px-4 rounded-full border flex items-center gap-2 shadow-xl ${isDarkMode ? 'bg-black/60 text-white border-white/10' : 'bg-white/80 text-zinc-900 border-zinc-200'}`}>
                     <ChevronLeft className="w-4 h-4 animate-pulse" />
                     <span>Swipe Right for Calendar</span>
                  </div>
               </div>
            )}

            <div className="fixed bottom-24 right-6 flex flex-col items-center gap-4 z-40">
                <div className={`flex flex-col gap-3 transition-all duration-300 ${showSpeedDial ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'}`}>
                    <button onClick={handleShortcutNutrition} className="w-12 h-12 bg-orange-600 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform relative group">
                        <Utensils className="w-6 h-6" />
                    </button>
                    <button onClick={handleShortcutAlarm} className="w-12 h-12 bg-purple-600 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform relative group">
                        <Clock className="w-6 h-6" />
                    </button>
                    <button onClick={handleShortcutSteps} className="w-12 h-12 bg-emerald-600 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform relative group">
                        <Footprints className="w-6 h-6" />
                    </button>
                </div>
                <button onClick={() => setShowSpeedDial(!showSpeedDial)} className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 ${showSpeedDial ? (isDarkMode ? 'bg-zinc-800 text-white rotate-45' : 'bg-zinc-200 text-zinc-900 rotate-45') : (isDarkMode ? 'bg-zinc-800 text-indigo-400' : 'bg-white text-indigo-600')}`}>
                    {showSpeedDial ? <Plus className="w-6 h-6" /> : <Zap className="w-6 h-6" />}
                </button>
            </div>

            <button onClick={() => setShowNoteMaker(true)} className="fixed bottom-6 right-6 w-14 h-14 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-xl shadow-indigo-900/50 hover:bg-indigo-500 hover:scale-105 active:scale-95 transition-all z-40">
                <Plus className="w-8 h-8" />
            </button>
        </div>
      </div>

      {showGlobalVoiceAgent && (
          <VoiceAgent 
            onClose={() => setShowGlobalVoiceAgent(false)}
            onCreateNote={handleVoiceNoteCreation}
            onEditNote={handleVoiceNoteEdit}
            onDeleteNote={handleVoiceNoteDelete}
            existingNotes={notes}
            isEmbedded={false}
            isDarkMode={isDarkMode}
          />
      )}

      {showNoteMaker && (
        <NoteMakerModal 
            onClose={() => setShowNoteMaker(false)}
            onSave={handleNoteMakerSave}
            onCameraClick={() => setIsCameraOpen(true)}
            attachment={pendingAttachment}
            onRemoveAttachment={() => setPendingAttachment(null)}
            isDarkMode={isDarkMode}
            isHidden={isCameraOpen}
        />
      )}
    </div>
  );
};

export default App;