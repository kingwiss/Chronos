import React, { useState, useEffect, useRef } from 'react';
import { Note, NoteType } from '../types';
import { Clock, Footprints, Utensils, FileText, Wand2, Play, Pause, Activity, Pencil, Mic, Check, Trash2, X, CheckCircle2, Timer, Loader2 } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { generateNoteImage } from '../services/geminiService';

interface NoteCardProps {
  note: Note;
  onUpdate: (updatedNote: Note) => void;
  onCreate: (note: Note) => void;
  onSmartUpdate: (id: string, newText: string) => Promise<void>;
  onDelete: (id: string) => void;
  isDarkMode?: boolean;
  onSmartFeatureAttempt: () => Promise<boolean>;
}

// --- Audio Helpers ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createAudioBlob(data: Float32Array, sampleRate: number) {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  const uint8 = new Uint8Array(int16.buffer);
  return {
    data: encode(uint8),
    mimeType: `audio/pcm;rate=${sampleRate}`,
  };
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const alignedData = new Uint8Array(data.length);
  alignedData.set(data);
  let bufferToUse = alignedData.buffer;
  if (alignedData.byteLength % 2 !== 0) {
      const padded = new Uint8Array(alignedData.byteLength + 1);
      padded.set(alignedData);
      bufferToUse = padded.buffer;
  }
  const int16Data = new Int16Array(bufferToUse);
  const frameCount = int16Data.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = int16Data[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export const NoteCard: React.FC<NoteCardProps> = ({ note, onUpdate, onCreate, onSmartUpdate, onDelete, isDarkMode = true, onSmartFeatureAttempt }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [manualEditValue, setManualEditValue] = useState(note.content);
  const [isProcessing, setIsProcessing] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>('');
  
  // Voice State
  const [voiceState, setVoiceState] = useState<'idle' | 'initializing' | 'listening' | 'processing' | 'speaking'>('idle');
  const sessionRef = useRef<Promise<any> | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Step Tracker State
  const [isTracking, setIsTracking] = useState(note.type === NoteType.STEPS_TRACKER);
  const [liveSteps, setLiveSteps] = useState(note.steps?.count || 0);
  const isAboveThresholdRef = useRef<boolean>(false);
  const stepCountRef = useRef<number>(note.steps?.count || 0);
  const lastStepTimeRef = useRef<number>(0);

  const MAGNITUDE_THRESHOLD_PEAK = 12.5; 
  const MAGNITUDE_THRESHOLD_RESET = 11.0; 
  const MIN_STEP_DELAY = 300; 

  // --- Timer Countdown Logic ---
  useEffect(() => {
    if (note.type === NoteType.TIMER && note.alarm?.time && !note.alarm.fired) {
      const target = new Date(note.alarm.time).getTime();
      const updateTimer = () => {
        const now = Date.now();
        const diff = target - now;
        if (diff <= 0) {
          setTimeLeft("00:00");
        } else {
          const minutes = Math.floor(diff / 60000);
          const seconds = Math.floor((diff % 60000) / 1000);
          setTimeLeft(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
        }
      };
      updateTimer();
      const interval = setInterval(updateTimer, 1000);
      return () => clearInterval(interval);
    } else if (note.type === NoteType.TIMER && note.alarm?.fired) {
      setTimeLeft("00:00");
    }
  }, [note.type, note.alarm?.time, note.alarm?.fired]);

  // --- Voice Session Logic ---

  const cleanupAudio = async () => {
     if (scriptProcessorRef.current) {
        try { scriptProcessorRef.current.disconnect(); } catch(e) {}
        scriptProcessorRef.current = null;
     }
     if (streamRef.current) {
        try { streamRef.current.getTracks().forEach(t => t.stop()); } catch(e) {}
        streamRef.current = null;
     }
     if (inputContextRef.current) {
        try { await inputContextRef.current.close(); } catch(e) {}
        inputContextRef.current = null;
     }
     if (outputContextRef.current) {
        try { await outputContextRef.current.close(); } catch(e) {}
        outputContextRef.current = null;
     }
     if (sessionRef.current) {
        try {
            const session = await sessionRef.current;
            if(session.close) session.close();
        } catch (e) {}
        sessionRef.current = null;
     }
     sourcesRef.current.clear();
  };

  const stopVoiceSession = async () => {
     await cleanupAudio();
     setVoiceState('idle');
  };

  const startVoiceSession = async (preInputCtx?: AudioContext, preOutputCtx?: AudioContext) => {
    try {
       setVoiceState('initializing');
       
       const apiKey = process.env.API_KEY || '';
       if (!apiKey) {
           console.error("No API key found");
           setVoiceState('idle');
           return;
       }
       const ai = new GoogleGenAI({ apiKey });

       const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
       
       // Use pre-created contexts if available (to satisfy browser autoplay policy)
       const inputAudioContext = preInputCtx || new AudioContextClass({ sampleRate: 16000 }); 
       const outputAudioContext = preOutputCtx || new AudioContextClass({ sampleRate: 24000 }); 
       
       inputContextRef.current = inputAudioContext;
       outputContextRef.current = outputAudioContext;

       // Ensure resumption even if passed in (idempotent)
       await Promise.all([
           inputAudioContext.state === 'suspended' ? inputAudioContext.resume() : Promise.resolve(), 
           outputAudioContext.state === 'suspended' ? outputAudioContext.resume() : Promise.resolve()
       ]);
       
       const outputNode = outputAudioContext.createGain();
       outputNode.connect(outputAudioContext.destination);

       const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
       streamRef.current = audioStream;

       // Tools Definition - FLATTENED SCHEMA
       const updateNoteTool: FunctionDeclaration = {
          name: "updateNote",
          description: "Update the note content or properties immediately.",
          parameters: {
             type: Type.OBJECT,
             properties: {
                content: { type: Type.STRING },
                type: { type: Type.STRING, description: "One of: MEMO, ALARM, TIMER, STEPS, STEPS_TRACKER, NUTRITION" },
                alarmTime: { type: Type.STRING },
                stepsCount: { type: Type.NUMBER },
                visualDescription: { type: Type.STRING },
                nutritionFoodName: { type: Type.STRING },
                nutritionCalories: { type: Type.NUMBER },
                nutritionCarbs: { type: Type.NUMBER },
                nutritionProtein: { type: Type.NUMBER },
                nutritionFat: { type: Type.NUMBER }
             }
          }
       };

       const createNoteTool: FunctionDeclaration = {
          name: "createNote",
          description: "Create a NEW note.",
          parameters: {
             type: Type.OBJECT,
             properties: {
                content: { type: Type.STRING },
                type: { type: Type.STRING, description: "One of: MEMO, ALARM, TIMER, STEPS, STEPS_TRACKER, NUTRITION" },
                alarmTime: { type: Type.STRING },
             },
             required: ["content", "type"]
          }
       };

       const deleteNoteTool: FunctionDeclaration = {
          name: "deleteNote",
          description: "Delete this note.",
          parameters: { type: Type.OBJECT, properties: {} }
       };

       const sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          config: {
             responseModalities: [Modality.AUDIO],
             tools: [{ functionDeclarations: [updateNoteTool, createNoteTool, deleteNoteTool] }],
             systemInstruction: `You are Chronos.
             NOTE CONTEXT: ID: "${note.id}", Content: "${note.content}"
             Job: Update THIS note or create new ones. Be fast. Call tools immediately.`,
             speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          },
          callbacks: {
             onopen: () => {
                setVoiceState('listening');
                const source = inputAudioContext.createMediaStreamSource(audioStream);
                const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
                scriptProcessorRef.current = scriptProcessor;

                scriptProcessor.onaudioprocess = (e) => {
                   const inputData = e.inputBuffer.getChannelData(0);
                   const blob = createAudioBlob(inputData, inputAudioContext.sampleRate);
                   sessionPromise.then(session => session.sendRealtimeInput({ media: blob }));
                };
                source.connect(scriptProcessor);
                scriptProcessor.connect(inputAudioContext.destination);
             },
             onmessage: async (msg: LiveServerMessage) => {
                try {
                  if (msg.toolCall) {
                    setVoiceState('processing'); // Visual feedback immediately on tool call
                    const responses = [];
                    for (const fc of msg.toolCall.functionCalls) {
                        let result: any = { ok: true };
                        if (fc.name === 'updateNote') {
                          const updates = fc.args as any;
                          const updatedNote = { ...note };
                          if (updates.type) updatedNote.type = updates.type as NoteType;
                          if (updates.content) updatedNote.content = updates.content;
                          
                          if (updates.visualDescription && (!note.imageUrl || note.isAiImage)) {
                                  const newImageBase64 = await generateNoteImage(updates.visualDescription);
                                  if (newImageBase64) {
                                      updatedNote.imageUrl = `data:image/jpeg;base64,${newImageBase64}`;
                                      updatedNote.isAiImage = true;
                                  }
                          }

                          if ((updates.type === NoteType.ALARM || updates.type === NoteType.TIMER) && updates.alarmTime) {
                              updatedNote.alarm = { time: updates.alarmTime, label: updates.content || 'Alarm' };
                          }
                          if (updates.type === NoteType.STEPS && updates.stepsCount) {
                              updatedNote.steps = { count: Number(updates.stepsCount) };
                          }
                          
                          // Reconstruct nutrition data from flat fields
                          if (updates.type === NoteType.NUTRITION && (updates.nutritionFoodName || updates.nutritionCalories)) {
                              updatedNote.nutrition = {
                                  foodName: updates.nutritionFoodName || 'Food',
                                  calories: Number(updates.nutritionCalories) || 0,
                                  carbs: Number(updates.nutritionCarbs) || 0,
                                  protein: Number(updates.nutritionProtein) || 0,
                                  fat: Number(updates.nutritionFat) || 0
                              };
                          }
                          
                          onUpdate(updatedNote);
                          if (!result.error) result = { updated: true };
                        } else if (fc.name === 'createNote') {
                          const args = fc.args as any;
                          let newNoteImage = undefined;
                          if (args.content) {
                              const gen = await generateNoteImage(args.content);
                              if (gen) newNoteImage = `data:image/jpeg;base64,${gen}`;
                          }
                          onCreate({
                              id: crypto.randomUUID(),
                              createdAt: new Date(),
                              type: args.type || NoteType.MEMO,
                              content: args.content,
                              imageUrl: newNoteImage,
                              isAiImage: !!newNoteImage,
                              alarm: args.alarmTime ? { time: args.alarmTime, label: args.content } : undefined
                          });
                          result = { created: true };
                        } else if (fc.name === 'deleteNote') {
                          onDelete(note.id);
                          stopVoiceSession();
                          return;
                        }
                        responses.push({ id: fc.id, name: fc.name, response: { result } });
                    }
                    sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
                  }

                  if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                    const audioData = msg.serverContent.modelTurn.parts[0].inlineData.data;
                    setVoiceState('speaking');
                    
                    const buffer = await decodeAudioData(decode(audioData), outputAudioContext, 24000, 1);
                    
                    if (nextStartTimeRef.current < outputAudioContext.currentTime) {
                        nextStartTimeRef.current = outputAudioContext.currentTime;
                    }

                    const source = outputAudioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(outputNode);
                    source.addEventListener('ended', () => {
                        sourcesRef.current.delete(source);
                        if (sourcesRef.current.size === 0) setVoiceState('listening');
                    });
                    source.start(nextStartTimeRef.current);
                    nextStartTimeRef.current += buffer.duration;
                    sourcesRef.current.add(source);
                  }
                } catch (err) {
                   console.error("Error processing voice message", err);
                }
             },
             onclose: () => setVoiceState('idle'),
             onerror: (e: any) => {
                console.error(e);
                setVoiceState('idle');
             }
          }
       });
       sessionRef.current = sessionPromise;

    } catch (e) {
       console.error("Failed to start note voice session", e);
       setVoiceState('idle');
    }
  };

  const toggleVoiceInteraction = async () => {
     if (voiceState === 'idle') {
        // 1. Initialize Audio Contexts IMMEDIATELY on click to satisfy browser autoplay policy.
        // This 'user gesture' capture is crucial before any async calls.
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const inputCtx = new AudioContextClass({ sampleRate: 16000 });
        const outputCtx = new AudioContextClass({ sampleRate: 24000 });
        
        // Fire and forget resume to ensure they are active
        inputCtx.resume().catch(() => {});
        outputCtx.resume().catch(() => {});

        // 2. Perform async checks (db permissions etc)
        const allowed = await onSmartFeatureAttempt();
        if (allowed) {
            // 3. Pass pre-warmed contexts to session
            await startVoiceSession(inputCtx, outputCtx);
        } else {
            // Cleanup if permission denied
            inputCtx.close();
            outputCtx.close();
        }
     } else {
        await stopVoiceSession();
     }
  };

  // Cleanup on unmount
  useEffect(() => {
     return () => { cleanupAudio(); };
  }, []);


  // --- Step Tracker Logic ---
  useEffect(() => {
    if (note.steps?.count !== undefined) {
       stepCountRef.current = note.steps.count;
       setLiveSteps(note.steps.count);
    }
  }, [note.steps?.count]);

  useEffect(() => {
    if (note.type === NoteType.STEPS_TRACKER && isTracking) {
      const handleMotion = (event: DeviceMotionEvent) => {
        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) return;
        
        const magnitude = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        const now = Date.now();

        if (magnitude > MAGNITUDE_THRESHOLD_PEAK && !isAboveThresholdRef.current) {
           if (now - lastStepTimeRef.current > MIN_STEP_DELAY) {
               isAboveThresholdRef.current = true;
               lastStepTimeRef.current = now;
               const newCount = stepCountRef.current + 1;
               stepCountRef.current = newCount;
               setLiveSteps(newCount);
               if (newCount % 5 === 0) {
                   onUpdate({ ...note, steps: { ...note.steps, count: newCount, isLive: true } });
               }
           }
        } else if (magnitude < MAGNITUDE_THRESHOLD_RESET) {
            isAboveThresholdRef.current = false;
        }
      };

      if ((typeof DeviceMotionEvent as any).requestPermission === 'function') {
         (DeviceMotionEvent as any).requestPermission().then((response: string) => {
               if (response === 'granted') window.addEventListener('devicemotion', handleMotion);
            }).catch(console.error);
      } else {
         window.addEventListener('devicemotion', handleMotion);
      }

      return () => {
         window.removeEventListener('devicemotion', handleMotion);
         if (stepCountRef.current !== note.steps?.count) {
            onUpdate({ ...note, steps: { ...note.steps, count: stepCountRef.current, isLive: true } });
         }
      };
    }
  }, [isTracking, note.id]); 

  const handleManualSave = async () => {
     if (!manualEditValue.trim()) return;
     setIsProcessing(true);
     await onSmartUpdate(note.id, manualEditValue);
     setIsProcessing(false);
     setIsEditing(false);
  };

  const toggleTracking = async () => {
    if (!isTracking) {
        // Resume/Start Tracking is a Smart Feature
        const allowed = await onSmartFeatureAttempt();
        if (!allowed) return;

        if ((typeof DeviceMotionEvent as any).requestPermission === 'function') {
            (DeviceMotionEvent as any).requestPermission().then((response: string) => {
                    if (response === 'granted') setIsTracking(true);
                }).catch(console.error);
        } else {
            setIsTracking(true);
        }
    } else {
        setIsTracking(false);
    }
  };

  const getIcon = () => {
    switch (note.type) {
      case NoteType.ALARM: return <Clock className="w-5 h-5 text-purple-400" />;
      case NoteType.TIMER: return <Timer className="w-5 h-5 text-pink-400" />;
      case NoteType.STEPS: 
      case NoteType.STEPS_TRACKER: return <Footprints className="w-5 h-5 text-emerald-400" />;
      case NoteType.NUTRITION: return <Utensils className="w-5 h-5 text-orange-400" />;
      default: return <FileText className="w-5 h-5 text-blue-400" />;
    }
  };

  const getBorderColor = () => {
    if ((note.type === NoteType.ALARM || note.type === NoteType.TIMER) && note.alarm?.fired) {
        return isDarkMode ? 'border-zinc-800 bg-zinc-900/50 opacity-60' : 'border-zinc-200 bg-zinc-100 opacity-60';
    }
    switch (note.type) {
      case NoteType.ALARM: return isDarkMode ? 'border-purple-500/30 bg-purple-500/5' : 'border-purple-200 bg-purple-50';
      case NoteType.TIMER: return isDarkMode ? 'border-pink-500/30 bg-pink-500/5' : 'border-pink-200 bg-pink-50';
      case NoteType.STEPS: 
      case NoteType.STEPS_TRACKER: return isDarkMode ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-emerald-200 bg-emerald-50';
      case NoteType.NUTRITION: return isDarkMode ? 'border-orange-500/30 bg-orange-500/5' : 'border-orange-200 bg-orange-50';
      default: return isDarkMode ? 'border-blue-500/30 bg-blue-500/5' : 'border-blue-100 bg-white shadow-sm';
    }
  };

  const formatAlarmTime = (timeStr?: string) => {
      if (!timeStr) return '';
      const date = new Date(timeStr);
      if (!isNaN(date.getTime())) {
          return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      return timeStr;
  };

  return (
    <div className={`relative flex flex-col gap-3 p-5 rounded-2xl border transition-all duration-300 group ${getBorderColor()} ${isDarkMode ? 'backdrop-blur-md' : ''}`}>
      
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 opacity-70">
          {getIcon()}
          <span className={`text-xs font-mono uppercase tracking-wider ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>{note.type.replace('_', ' ')}</span>
          {((note.type === NoteType.ALARM || note.type === NoteType.TIMER) && note.alarm?.fired) && <span className={`text-[10px] px-1.5 py-0.5 rounded ${isDarkMode ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-200 text-zinc-500'}`}>FIRED</span>}
        </div>
        <div className="flex items-center gap-3">
             <span className={`text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>{note.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
             
             {/* Note Actions */}
             <div className="flex items-center gap-1">
                {showDeleteConfirm ? (
                   <div className="flex items-center gap-1 bg-red-950/50 border border-red-900/50 rounded-lg px-1.5 py-0.5 animate-in fade-in slide-in-from-right-2">
                      <span className="text-[10px] text-red-400 font-bold mr-1">Sure?</span>
                      <button 
                        onClick={() => onDelete(note.id)} 
                        className="p-1 text-red-400 hover:text-red-200 hover:bg-red-900/50 rounded-md transition-colors"
                        title="Yes, delete it"
                      >
                         <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={() => setShowDeleteConfirm(false)} 
                        className={`p-1 rounded-md transition-colors ${isDarkMode ? 'text-zinc-400 hover:text-white hover:bg-zinc-800' : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200'}`}
                        title="Cancel"
                      >
                         <X className="w-3.5 h-3.5" />
                      </button>
                   </div>
                ) : (
                   <>
                     <button onClick={() => setIsEditing(!isEditing)} className={`p-1.5 rounded-md transition-colors ${isDarkMode ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-zinc-200 text-zinc-400 hover:text-zinc-700'}`} title="Edit text">
                        <Pencil className="w-3.5 h-3.5" />
                     </button>
                     
                     {/* Smart Voice Action Button */}
                     <button 
                        onClick={toggleVoiceInteraction} 
                        disabled={voiceState === 'initializing'}
                        className={`p-1.5 rounded-md transition-all duration-300 relative overflow-hidden ${
                            voiceState === 'speaking' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/50' :
                            voiceState === 'listening' ? 'bg-red-600 text-white shadow-lg shadow-red-500/50 animate-pulse' :
                            voiceState === 'processing' ? 'bg-indigo-600/50 text-white cursor-wait' :
                            voiceState === 'initializing' ? 'bg-zinc-700 text-zinc-400 cursor-wait' :
                            (isDarkMode ? 'hover:bg-indigo-900/30 text-indigo-400 hover:text-indigo-300' : 'hover:bg-indigo-50 text-indigo-500 hover:text-indigo-600')
                        }`} 
                        title="Talk to Chronos about this note"
                     >
                        {voiceState === 'speaking' && (
                            <div className="absolute inset-0 bg-indigo-400 opacity-30 animate-ping"></div>
                        )}
                        
                        {voiceState === 'idle' ? <Mic className="w-3.5 h-3.5" /> : 
                         (voiceState === 'initializing' || voiceState === 'processing') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                         <Activity className="w-3.5 h-3.5 animate-pulse" />}
                     </button>
                     
                     <button onClick={() => setShowDeleteConfirm(true)} className={`p-1.5 rounded-md transition-colors ${isDarkMode ? 'hover:bg-red-900/20 text-zinc-400 hover:text-red-400' : 'hover:bg-red-50 text-zinc-400 hover:text-red-500'}`} title="Delete note">
                        <Trash2 className="w-3.5 h-3.5" />
                     </button>
                   </>
                )}
             </div>
        </div>
      </div>

      {/* Content */}
      {note.imageUrl && (
        <div className={`rounded-lg overflow-hidden my-2 max-h-64 border group relative ${isDarkMode ? 'border-zinc-800' : 'border-zinc-200'}`}>
          <img src={note.imageUrl} alt="Note attachment" className="w-full h-full object-cover" />
          {note.isAiImage && <div className="absolute top-2 right-2 bg-indigo-500/80 backdrop-blur-md text-[10px] px-2 py-0.5 rounded-full text-white font-bold tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">AI</div>}
        </div>
      )}

      {isEditing ? (
         <div className="animate-in fade-in">
            <textarea 
               value={manualEditValue}
               onChange={(e) => setManualEditValue(e.target.value)}
               className={`w-full rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 min-h-[80px] ${isDarkMode ? 'bg-zinc-900/50 border border-zinc-700 text-white' : 'bg-white border border-zinc-200 text-zinc-900'}`}
            />
            <div className="flex justify-end gap-2 mt-2">
               <button onClick={() => setIsEditing(false)} disabled={isProcessing} className={`text-xs px-3 py-1.5 rounded-md ${isDarkMode ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500'}`}>Cancel</button>
               <button onClick={handleManualSave} disabled={isProcessing} className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                  {isProcessing ? <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin"></div> : <Check className="w-3 h-3" />} 
                  {isProcessing ? 'Updating...' : 'Save'}
               </button>
            </div>
         </div>
      ) : (
         <div className={`text-sm md:text-base whitespace-pre-wrap leading-relaxed ${isDarkMode ? 'text-zinc-200' : 'text-zinc-800'}`}>
            {note.content}
         </div>
      )}

      {/* NUTRITION Display */}
      {note.type === NoteType.NUTRITION && note.nutrition && (
        <div className="grid grid-cols-4 gap-2 mt-2">
          <div className={`p-2 rounded text-center border ${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-zinc-200'}`}>
            <div className={`text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>KCAL</div>
            <div className="font-bold text-orange-400">{note.nutrition.calories}</div>
          </div>
          <div className={`p-2 rounded text-center border ${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-zinc-200'}`}>
            <div className={`text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>CARB</div>
            <div className={`font-bold ${isDarkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>{note.nutrition.carbs}g</div>
          </div>
          <div className={`p-2 rounded text-center border ${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-zinc-200'}`}>
            <div className={`text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>PROT</div>
            <div className={`font-bold ${isDarkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>{note.nutrition.protein}g</div>
          </div>
          <div className={`p-2 rounded text-center border ${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-zinc-200'}`}>
            <div className={`text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>FAT</div>
            <div className={`font-bold ${isDarkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>{note.nutrition.fat}g</div>
          </div>
        </div>
      )}

      {/* ALARM Display */}
      {note.type === NoteType.ALARM && note.alarm && (
        <div className={`mt-2 flex items-center gap-3 p-3 rounded-lg border ${note.alarm.fired ? (isDarkMode ? 'bg-zinc-800/50 border-zinc-800' : 'bg-zinc-100 border-zinc-200') : 'bg-purple-900/20 border-purple-500/20'}`}>
          <Clock className={`w-6 h-6 ${note.alarm.fired ? 'text-zinc-500' : 'text-purple-400'}`} />
          <div>
            <div className={`text-lg font-bold ${note.alarm.fired ? 'text-zinc-500' : (isDarkMode ? 'text-purple-200' : 'text-purple-800')}`}>{formatAlarmTime(note.alarm.time)}</div>
            <div className="text-xs text-zinc-500">{note.alarm.label || 'Alarm set'}</div>
          </div>
        </div>
      )}

      {/* TIMER Display */}
      {note.type === NoteType.TIMER && note.alarm && (
        <div className={`mt-2 flex items-center gap-3 p-3 rounded-lg border ${note.alarm.fired ? (isDarkMode ? 'bg-zinc-800/50 border-zinc-800' : 'bg-zinc-100 border-zinc-200') : 'bg-pink-900/20 border-pink-500/20'}`}>
          <Timer className={`w-6 h-6 ${note.alarm.fired ? 'text-zinc-500' : 'text-pink-400'} ${!note.alarm.fired ? 'animate-pulse' : ''}`} />
          <div className="flex-1">
             <div className="flex items-center justify-between">
                <div className={`text-2xl font-mono font-bold ${note.alarm.fired ? 'text-zinc-500' : (isDarkMode ? 'text-pink-200' : 'text-pink-700')}`}>
                   {timeLeft || "--:--"}
                </div>
                <div className={`text-xs px-2 py-1 rounded ${isDarkMode ? 'bg-black/20 text-zinc-500' : 'bg-white/50 text-zinc-500'}`}>
                   End: {formatAlarmTime(note.alarm.time)}
                </div>
             </div>
             <div className="text-xs text-zinc-500 mt-1">{note.alarm.label || 'Countdown'}</div>
          </div>
        </div>
      )}

      {/* STATIC STEPS Display */}
      {note.type === NoteType.STEPS && note.steps && (
        <div className="mt-2 flex items-center justify-between bg-emerald-900/20 p-3 rounded-lg border border-emerald-500/20">
           <div className="flex items-center gap-2">
             <Footprints className="w-5 h-5 text-emerald-400" />
             <span className={`font-medium ${isDarkMode ? 'text-emerald-200' : 'text-emerald-800'}`}>Recorded Steps</span>
           </div>
           <div className="text-2xl font-bold text-emerald-400">{note.steps.count}</div>
        </div>
      )}

      {/* LIVE STEPS TRACKER Display */}
      {note.type === NoteType.STEPS_TRACKER && (
         <div className="mt-2 bg-emerald-900/10 p-4 rounded-xl border border-emerald-500/20 flex flex-col items-center gap-2 relative overflow-hidden">
            {isTracking && (
              <div className="absolute inset-0 bg-emerald-500/5 animate-pulse"></div>
            )}
            
            <div className="relative z-10 flex flex-col items-center">
              <div className="flex items-end gap-2">
                 <div className="text-5xl font-black text-emerald-400 tabular-nums tracking-tighter">
                    {liveSteps}
                 </div>
                 <div className="mb-2">
                    {isTracking ? <Activity className="w-5 h-5 text-emerald-500 animate-bounce" /> : <div className="w-5 h-5" />}
                 </div>
              </div>
              <div className="text-xs text-emerald-500/60 font-bold uppercase tracking-widest mt-1">
                 Live Step Count
              </div>
            </div>

            <button 
              onClick={toggleTracking}
              className={`mt-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold transition-all z-10 ${isTracking ? 'bg-zinc-800 text-emerald-500 border border-emerald-500/30' : (isDarkMode ? 'bg-zinc-800 text-zinc-400 border border-zinc-700' : 'bg-white text-zinc-500 border border-zinc-200')}`}
            >
              {isTracking ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {isTracking ? 'Pause Tracking' : 'Resume Tracking'}
            </button>
            
            {isTracking && (
               <p className="text-[10px] text-zinc-500 text-center mt-2 z-10">
                 Tracking active. Keep phone in pocket for accuracy.
               </p>
            )}
         </div>
      )}
    </div>
  );
};