import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { Mic, X, Loader2, Volume2, StopCircle } from 'lucide-react';
import { Note, NoteType } from '../types';

interface VoiceAgentProps {
  onClose: () => void;
  onCreateNote: (data: any) => void;
  onEditNote: (id: string, content: string) => void;
  onDeleteNote: (id: string) => void;
  onCommandComplete?: () => void;
  existingNotes: Note[];
  isEmbedded?: boolean;
  isDarkMode?: boolean;
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

export const VoiceAgent: React.FC<VoiceAgentProps> = ({ 
  onClose, 
  onCreateNote, 
  onEditNote, 
  onDeleteNote,
  existingNotes,
  isEmbedded,
  isDarkMode 
}) => {
  const [voiceState, setVoiceState] = useState<'initializing' | 'listening' | 'speaking'>('initializing');
  
  const sessionRef = useRef<Promise<any> | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // --- Voice Logic ---
  const cleanupAudio = async () => {
     if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
     }
     if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
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
            if (session.close) session.close();
        } catch (e) {}
        sessionRef.current = null;
     }
  };

  const startVoiceSession = async () => {
    try {
       await cleanupAudio();
       setVoiceState('initializing');
       
       const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

       const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
       const inputAudioContext = new AudioContextClass(); 
       const outputAudioContext = new AudioContextClass(); 
       
       inputContextRef.current = inputAudioContext;
       outputContextRef.current = outputAudioContext;

       await Promise.all([inputAudioContext.resume(), outputAudioContext.resume()]);
       
       const outputNode = outputAudioContext.createGain();
       outputNode.connect(outputAudioContext.destination);

       const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
       streamRef.current = audioStream;

       // Tools Definition - FLATTENED SCHEMA
       const createNoteTool: FunctionDeclaration = {
          name: "createNote",
          description: "Create a NEW note.",
          parameters: {
             type: Type.OBJECT,
             properties: {
                content: { type: Type.STRING },
                type: { type: Type.STRING, description: "One of: MEMO, ALARM, TIMER, STEPS, STEPS_TRACKER, NUTRITION" },
                alarmTime: { type: Type.STRING },
                stepsCount: { type: Type.NUMBER },
                nutritionFoodName: { type: Type.STRING },
                nutritionCalories: { type: Type.NUMBER },
                nutritionCarbs: { type: Type.NUMBER },
                nutritionProtein: { type: Type.NUMBER },
                nutritionFat: { type: Type.NUMBER }
             },
             required: ["content", "type"]
          }
       };

       const updateNoteTool: FunctionDeclaration = {
          name: "updateNote",
          description: "Update an EXISTING note by ID.",
          parameters: {
             type: Type.OBJECT,
             properties: {
                id: { type: Type.STRING, description: "The ID of the note to update" },
                content: { type: Type.STRING },
             },
             required: ["id", "content"]
          }
       };

       const deleteNoteTool: FunctionDeclaration = {
          name: "deleteNote",
          description: "Delete a note by ID.",
          parameters: {
             type: Type.OBJECT,
             properties: {
                id: { type: Type.STRING }
             },
             required: ["id"]
          }
       };

       const sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          config: {
             responseModalities: [Modality.AUDIO],
             tools: [{ functionDeclarations: [createNoteTool, updateNoteTool, deleteNoteTool] }],
             systemInstruction: `You are Chronos, the main AI assistant.
             Current Time: ${new Date().toLocaleString()}
             
             EXISTING NOTES CONTEXT:
             ${existingNotes.map(n => `- [${n.id}] ${n.type}: ${n.content.substring(0, 50)}...`).join('\n')}

             Your Job:
             1. Help user create, edit, or delete notes.
             2. If creating a note, use 'createNote'. Determine type automatically.
             3. If editing, find the ID from context and use 'updateNote'.
             4. If deleting, find ID and use 'deleteNote'.
             5. Keep responses brief and helpful.`,
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
                if (msg.toolCall) {
                    const responses = [];
                    for (const fc of msg.toolCall.functionCalls) {
                        const args = fc.args as any;
                        let result: any = { ok: true };

                        if (fc.name === 'createNote') {
                            const noteData: any = {
                                content: args.content,
                                type: args.type,
                                alarmTime: args.alarmTime,
                                stepsCount: args.stepsCount
                            };
                            
                            if (args.type === NoteType.NUTRITION && (args.nutritionFoodName || args.nutritionCalories)) {
                                noteData.nutritionData = {
                                    foodName: args.nutritionFoodName || 'Food',
                                    calories: Number(args.nutritionCalories) || 0,
                                    carbs: Number(args.nutritionCarbs) || 0,
                                    protein: Number(args.nutritionProtein) || 0,
                                    fat: Number(args.nutritionFat) || 0
                                };
                            }

                            onCreateNote(noteData);
                            result = { created: true };
                        } else if (fc.name === 'updateNote') {
                            onEditNote(args.id, args.content);
                            result = { updated: true };
                        } else if (fc.name === 'deleteNote') {
                            onDeleteNote(args.id);
                            result = { deleted: true };
                        }
                        responses.push({ id: fc.id, name: fc.name, response: { result } });
                    }
                    if (responses.length > 0) {
                        sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
                    }
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
             },
             onclose: () => onClose(),
             onerror: (e) => {
                 console.error(e);
                 onClose();
             }
          }
       });
       sessionRef.current = sessionPromise;

    } catch (e) {
       console.error("Failed to start global voice session", e);
       onClose();
    }
  };

  useEffect(() => {
     startVoiceSession();
     return () => { cleanupAudio(); };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in">
        <div className={`relative w-full max-w-sm aspect-square rounded-full flex flex-col items-center justify-center transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-zinc-200'}`}>
            
            {/* Ambient Rings */}
            <div className={`absolute inset-0 rounded-full border-2 border-indigo-500/20 animate-[spin_10s_linear_infinite]`}></div>
            <div className={`absolute inset-4 rounded-full border-2 border-purple-500/20 animate-[spin_15s_linear_infinite_reverse]`}></div>

            {/* Visualizer */}
            <div className="relative z-10 flex items-center gap-1.5 h-16">
                 {[1,2,3,4,5].map(i => (
                     <div key={i} className={`w-2 bg-gradient-to-t from-indigo-500 to-purple-500 rounded-full transition-all duration-100 ${
                         voiceState === 'speaking' ? 'h-12 animate-[wave_0.5s_ease-in-out_infinite]' : 
                         voiceState === 'listening' ? 'h-4 animate-pulse' : 'h-2'
                     }`} style={{ animationDelay: `${i * 0.1}s` }}></div>
                 ))}
            </div>

            <div className={`mt-8 text-center ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                {voiceState === 'initializing' && "Connecting..."}
                {voiceState === 'listening' && "Listening..."}
                {voiceState === 'speaking' && "Speaking..."}
            </div>

            <button 
                onClick={onClose}
                className="absolute bottom-10 p-3 rounded-full bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all"
            >
                <X className="w-6 h-6" />
            </button>
        </div>
    </div>
  );
};