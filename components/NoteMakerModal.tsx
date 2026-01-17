import React, { useState, useEffect, useRef } from 'react';
import { Mic, Camera, Check, X, Loader2, Activity, Trash2, StopCircle, Volume2, Clock, Timer, Footprints, Utensils } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { NoteType, DraftData } from '../types';

// Audio Helpers
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

interface NoteMakerModalProps {
  onClose: () => void;
  onSave: (draft: DraftData) => Promise<void>;
  onCameraClick: () => void;
  attachment: string | null;
  onRemoveAttachment: () => void;
  isDarkMode: boolean;
  isHidden?: boolean;
}

export const NoteMakerModal: React.FC<NoteMakerModalProps> = ({
  onClose,
  onSave,
  onCameraClick,
  attachment,
  onRemoveAttachment,
  isDarkMode,
  isHidden = false
}) => {
  const [content, setContent] = useState('');
  const [draftType, setDraftType] = useState<NoteType>(NoteType.MEMO);
  const [draftMetadata, setDraftMetadata] = useState<Partial<DraftData>>({});
  
  const [isListening, setIsListening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Voice State
  const sessionRef = useRef<Promise<any> | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Ref to access current content in closures
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

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
            if(session.close) session.close();
        } catch (e) {}
        sessionRef.current = null;
    }
    sourcesRef.current.clear();
    setIsListening(false);
    setIsSpeaking(false);
  };

  const startVoiceSession = async () => {
    try {
        await cleanupAudio();
        setIsListening(true);

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const inputAudioContext = new AudioContextClass({ sampleRate: 16000 });
        const outputAudioContext = new AudioContextClass({ sampleRate: 24000 });
        
        inputContextRef.current = inputAudioContext;
        outputContextRef.current = outputAudioContext;
        nextStartTimeRef.current = 0;

        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = audioStream;

        // Flattened Tool Schema
        const updateDraftTool: FunctionDeclaration = {
          name: "updateDraft",
          description: "Update the note content, type, or settings. You must call this whenever the user asks to change the note, set an alarm, or logs info.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              content: { type: Type.STRING, description: "The full text content of the note." },
              type: { type: Type.STRING, enum: ['MEMO', 'ALARM', 'TIMER', 'STEPS', 'STEPS_TRACKER', 'NUTRITION'], description: "The type of the note." },
              alarmTime: { type: Type.STRING, description: "ISO 8601 timestamp for ALARM or TIMER." },
              stepsCount: { type: Type.NUMBER, description: "Count for STEPS note." },
              visualDescription: { type: Type.STRING, description: "Description for AI image generation." },
              // Flattened Nutrition Data
              nutritionFoodName: { type: Type.STRING },
              nutritionCalories: { type: Type.NUMBER },
              nutritionCarbs: { type: Type.NUMBER },
              nutritionProtein: { type: Type.NUMBER },
              nutritionFat: { type: Type.NUMBER },
            },
          }
        };

        const now = new Date();
        const systemInstruction = `You are Chronos, an intelligent notepad assistant.
        Current Date and Time: ${now.toString()}
        
        CONTEXT: The user is currently editing a note in a modal. 
        Current Text: "${contentRef.current}"

        CRITICAL RULES:
        1. The user CANNOT see your internal thoughts. You MUST call the 'updateDraft' tool to make any changes visible.
        2. If the user dictates text, call 'updateDraft' with the new full 'content'.
        3. If the user asks for an alarm (e.g., "Wake me at 7am"), calculate the ISO time and call 'updateDraft' with type='ALARM' and 'alarmTime'.
        4. If the user asks for a timer (e.g., "Timer for 10 mins"), calculate the end time and call 'updateDraft' with type='TIMER' and 'alarmTime'.
        5. If the user tracks steps or food, use the corresponding types and fields.
        6. Always respond verbally to confirm (e.g., "I've set the alarm for 7am"), but ONLY AFTER you have called the tool.
        `;

        const sessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-12-2025',
            config: {
                responseModalities: [Modality.AUDIO],
                tools: [{ functionDeclarations: [updateDraftTool] }],
                systemInstruction: systemInstruction,
            },
            callbacks: {
                onopen: () => {
                    const source = inputAudioContext.createMediaStreamSource(audioStream);
                    const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
                    scriptProcessorRef.current = scriptProcessor;
                    
                    scriptProcessor.onaudioprocess = (e) => {
                        const inputData = e.inputBuffer.getChannelData(0);
                        const blob = createAudioBlob(inputData, inputAudioContext.sampleRate);
                        sessionPromise.then(s => s.sendRealtimeInput({ media: blob }));
                    };
                    source.connect(scriptProcessor);
                    scriptProcessor.connect(inputAudioContext.destination);
                },
                onmessage: async (msg: LiveServerMessage) => {
                    // Handle Tool Calls (Content & Metadata Updates)
                    if (msg.toolCall) {
                        const responses = [];
                        for (const fc of msg.toolCall.functionCalls) {
                            if (fc.name === 'updateDraft') {
                                const args = fc.args as any;
                                const updates: any = {};
                                
                                // Direct State Updates
                                if (args.content !== undefined && args.content !== null) {
                                    setContent(args.content);
                                }
                                if (args.type) {
                                    setDraftType(args.type as NoteType);
                                }
                                
                                // Process metadata
                                if (args.alarmTime) updates.alarmTime = args.alarmTime;
                                if (args.stepsCount !== undefined) updates.stepsCount = Number(args.stepsCount);
                                if (args.visualDescription) updates.visualDescription = args.visualDescription;
                                
                                // Process Flattened Nutrition Data
                                if (args.nutritionFoodName || args.nutritionCalories) {
                                    updates.nutritionData = {
                                        foodName: args.nutritionFoodName || 'Food',
                                        calories: Number(args.nutritionCalories) || 0,
                                        carbs: Number(args.nutritionCarbs) || 0,
                                        protein: Number(args.nutritionProtein) || 0,
                                        fat: Number(args.nutritionFat) || 0
                                    };
                                }
                                
                                setDraftMetadata(prev => ({ ...prev, ...updates }));

                                responses.push({ 
                                    id: fc.id, 
                                    name: fc.name, 
                                    response: { result: { success: true } } 
                                });
                            }
                        }
                        sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
                    }

                    // Handle Audio Output (Conversation)
                    if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                        setIsSpeaking(true);
                        const audioData = msg.serverContent.modelTurn.parts[0].inlineData.data;
                        const buffer = await decodeAudioData(decode(audioData), outputAudioContext, 24000, 1);
                        
                        if (nextStartTimeRef.current < outputAudioContext.currentTime) {
                            nextStartTimeRef.current = outputAudioContext.currentTime;
                        }
                        
                        const source = outputAudioContext.createBufferSource();
                        source.buffer = buffer;
                        source.connect(outputAudioContext.destination);
                        
                        source.addEventListener('ended', () => {
                            sourcesRef.current.delete(source);
                            if (sourcesRef.current.size === 0) {
                                setIsSpeaking(false);
                            }
                        });
                        
                        source.start(nextStartTimeRef.current);
                        nextStartTimeRef.current += buffer.duration;
                        sourcesRef.current.add(source);
                    }
                },
                onclose: () => {
                    setIsListening(false);
                    setIsSpeaking(false);
                },
                onerror: (e) => {
                    console.error(e);
                    setIsListening(false);
                    setIsSpeaking(false);
                }
            }
        });
        sessionRef.current = sessionPromise;
    } catch (e) {
        console.error("Mic failed", e);
        setIsListening(false);
    }
  };

  const toggleMicrophone = async () => {
      if (isListening) {
          await cleanupAudio();
      } else {
          startVoiceSession();
      }
  };

  useEffect(() => {
      return () => { cleanupAudio(); };
  }, []);

  const handleSaveClick = async () => {
      if (!content.trim() && !attachment && draftType === NoteType.MEMO) return;
      setIsSaving(true);
      await cleanupAudio();
      
      try {
        await onSave({
            content,
            type: draftType,
            ...draftMetadata
        });
      } catch (error) {
        console.error("Save failed in modal:", error);
      }
      
      setIsSaving(false);
      onClose();
  };

  // Helper to render type indicator
  const renderTypeIndicator = () => {
      if (draftType === NoteType.MEMO) return null;

      let icon = <Check className="w-4 h-4" />;
      let text = draftType;
      let colorClass = "bg-zinc-100 text-zinc-600";

      switch (draftType) {
          case NoteType.ALARM:
              icon = <Clock className="w-4 h-4" />;
              text = draftMetadata.alarmTime ? new Date(draftMetadata.alarmTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Alarm';
              colorClass = "bg-purple-100 text-purple-700 border-purple-200";
              if (isDarkMode) colorClass = "bg-purple-900/30 text-purple-300 border-purple-800";
              break;
          case NoteType.TIMER:
              icon = <Timer className="w-4 h-4" />;
              text = draftMetadata.alarmTime ? 'Timer Set' : 'Timer';
              colorClass = "bg-pink-100 text-pink-700 border-pink-200";
              if (isDarkMode) colorClass = "bg-pink-900/30 text-pink-300 border-pink-800";
              break;
          case NoteType.STEPS:
          case NoteType.STEPS_TRACKER:
              icon = <Footprints className="w-4 h-4" />;
              text = "Steps Tracker";
              colorClass = "bg-emerald-100 text-emerald-700 border-emerald-200";
              if (isDarkMode) colorClass = "bg-emerald-900/30 text-emerald-300 border-emerald-800";
              break;
          case NoteType.NUTRITION:
              icon = <Utensils className="w-4 h-4" />;
              text = draftMetadata.nutritionData?.foodName || "Nutrition";
              colorClass = "bg-orange-100 text-orange-700 border-orange-200";
              if (isDarkMode) colorClass = "bg-orange-900/30 text-orange-300 border-orange-800";
              break;
      }

      return (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border animate-in slide-in-from-bottom-2 fade-in ${colorClass}`}>
              {icon}
              <span>{text}</span>
              <button 
                  onClick={() => { setDraftType(NoteType.MEMO); setDraftMetadata({}); }}
                  className="ml-1 hover:opacity-70"
              >
                  <X className="w-3 h-3" />
              </button>
          </div>
      );
  };

  return (
    <div className={`fixed inset-0 z-[80] items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in p-4 ${isHidden ? 'hidden' : 'flex'}`}>
        <div className={`w-full max-w-lg rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all ${isDarkMode ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'}`}>
            
            {/* Header */}
            <div className={`flex items-center justify-between p-4 border-b ${isDarkMode ? 'border-zinc-800' : 'border-zinc-100'}`}>
                <div className="flex items-center gap-3">
                    <h3 className={`font-semibold ${isDarkMode ? 'text-zinc-300' : 'text-zinc-600'}`}>New Note</h3>
                    {renderTypeIndicator()}
                </div>
                <button onClick={onClose} className={`p-2 rounded-full hover:bg-zinc-500/10 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 p-4 flex flex-col gap-4 min-h-[300px] relative">
                {attachment && (
                    <div className="relative rounded-xl overflow-hidden group shrink-0 max-h-64 bg-black/50 border border-zinc-700/50">
                        <img src={`data:image/jpeg;base64,${attachment}`} alt="Attachment" className="w-full h-full object-contain" />
                        <button 
                            onClick={onRemoveAttachment}
                            className="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                )}
                
                <textarea 
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={isListening ? "Listening..." : "Type a note, set an alarm, or log food..."}
                    className={`flex-1 w-full bg-transparent resize-none outline-none text-lg leading-relaxed ${isDarkMode ? 'text-zinc-100 placeholder-zinc-600' : 'text-zinc-800 placeholder-zinc-400'}`}
                    autoFocus
                />

                {isListening && (
                    <div className={`absolute bottom-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full animate-pulse border transition-colors ${isSpeaking ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                        {isSpeaking ? <Volume2 className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                        <span className="text-xs font-medium">{isSpeaking ? "Speaking..." : "Listening..."}</span>
                    </div>
                )}
            </div>

            {/* Footer Toolbar */}
            <div className={`p-4 flex items-center justify-between bg-gradient-to-t ${isDarkMode ? 'from-zinc-900 via-zinc-900 to-transparent' : 'from-white via-white to-transparent'}`}>
                <div className="flex items-center gap-2">
                    <button 
                        onClick={onCameraClick}
                        className={`p-3 rounded-full transition-all ${isDarkMode ? 'bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200'}`}
                        title="Add Photo"
                    >
                        <Camera className="w-5 h-5" />
                    </button>
                    <button 
                        onClick={toggleMicrophone}
                        className={`p-3 rounded-full transition-all ${isListening ? 'bg-red-500/10 text-red-500 ring-2 ring-red-500/50' : (isDarkMode ? 'bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200')}`}
                        title="Dictate Note"
                    >
                        {isListening ? <StopCircle className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                    </button>
                </div>

                <button 
                    onClick={handleSaveClick}
                    disabled={isSaving || (!content.trim() && !attachment && draftType === NoteType.MEMO)}
                    className={`flex items-center gap-2 px-6 py-3 rounded-full font-bold transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-900/20' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-200'}`}
                >
                    {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
                    <span>{isSaving ? 'Processing...' : 'Save Note'}</span>
                </button>
            </div>
        </div>
    </div>
  );
};