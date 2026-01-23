import { GoogleGenAI, Type } from "@google/genai";
import { ClassificationResult, NoteType, NutritionData } from "../types";

// Lazy initialization prevents top-level crashes if API Key is missing during build/runtime start
const getAiClient = () => {
    // The API key must be obtained exclusively from the environment variable process.env.API_KEY
    const key = process.env.API_KEY;
    
    // Fallback to avoid constructor error, though API calls will fail if key is invalid
    return new GoogleGenAI({ apiKey: key || 'dummy_key_for_init' });
};

// Generate a cute animated image for a note
export const generateNoteImage = async (prompt: string): Promise<string | null> => {
  try {
     const ai = getAiClient();
     const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
           parts: [{ text: `Create a cute, 3D isometric animated-style illustration representing this concept: "${prompt}". Minimalist, vibrant colors, white background. High quality icon style.` }]
        },
        config: {
            imageConfig: { aspectRatio: "1:1" }
        }
     });
     
     for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
            return part.inlineData.data;
        }
     }
     return null;
  } catch (e) {
     console.error("Image generation failed", e);
     return null;
  }
};

// Unified function to handle Text, Image, or Both
export const processMultiModalInput = async (text: string, base64Image?: string): Promise<ClassificationResult> => {
  try {
      const ai = getAiClient();
      // Use gemini-2.5-flash-image for multimodal tasks (image present), otherwise gemini-3-flash-preview for pure text logic
      const isImageModel = !!base64Image;
      const modelId = isImageModel ? "gemini-2.5-flash-image" : "gemini-3-flash-preview";
      
      const now = new Date();
      const timeContext = now.toString();

      const parts: any[] = [];
      
      // Add Image if present
      if (base64Image) {
        parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image,
          },
        });
      }

      // Add Text
      if (text) {
        parts.push({ text });
      } else if (base64Image) {
        // If only image is provided, give a default prompt
        parts.push({ text: "Analyze this image. If it is food, provide a nutrition breakdown. If it is not food, describe what you see in detail." });
      }

      // Define Schema (only used for text model)
      const schema = {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: [NoteType.MEMO, NoteType.ALARM, NoteType.TIMER, NoteType.STEPS, NoteType.STEPS_TRACKER, NoteType.NUTRITION] },
          content: { type: Type.STRING, description: "A clean summary of the note, or the answer to the user's question." },
          visualDescription: { type: Type.STRING, description: "A specific visual description if the user wants an image generated (e.g. for an Alarm or Memo). Provide this even for Alarms if implied." },
          steps: { type: Type.NUMBER, description: "Only for STEPS type" },
          alarmTime: { type: Type.STRING, description: "ISO 8601 Timestamp string for ALARM or TIMER (end time)" },
          alarmLabel: { type: Type.STRING, description: "Label for the alarm or timer" },
          nutrition: {
            type: Type.OBJECT,
            properties: {
              foodName: { type: Type.STRING },
              calories: { type: Type.NUMBER },
              carbs: { type: Type.NUMBER },
              protein: { type: Type.NUMBER },
              fat: { type: Type.NUMBER },
            },
            description: "Required if type is NUTRITION"
          }
        },
        required: ["type", "content"],
      };

      const systemInstruction = `You are a smart assistant for a notepad app. 
          Current Local Time: ${timeContext}
          
          Analyze the input.
          
          Categorize the user's intent: 
          - ALARM: Set a specific time reminder. Return 'alarmTime' (ISO 8601). 
          - TIMER: Countdown. Return 'alarmTime' (ISO 8601) calculated from now.
          - STEPS/STEPS_TRACKER: Log steps.
          - NUTRITION: Food logs.
          - MEMO: General notes.

          CRITICAL RULE: Always provide a 'visualDescription' for the note, even for simple memos, so I can generate a cool image for it.
          - If the user describes a scene (e.g., "Wake me up at 7am with a beach photo"), put "Wake me up at 7am" in 'content' and "A sunny beach at sunrise" in 'visualDescription'.
          - If the user says "Buy milk", put "Carton of milk" in 'visualDescription'.
          
          Return strictly valid JSON. Structure: { type, content, visualDescription?, steps?, alarmTime?, alarmLabel?, nutrition? }`;

      let config: any = {
        systemInstruction,
      };

      // Only apply JSON mode config for models that support it (gemini-3-flash-preview)
      if (!isImageModel) {
        config.responseMimeType = "application/json";
        config.responseSchema = schema;
      }

      const response = await ai.models.generateContent({
        model: modelId,
        contents: { parts },
        config,
      });

      let jsonText = response.text || "";
      
      // Clean markdown if present
      if (jsonText.includes("```")) {
        jsonText = jsonText.replace(/```json/g, "").replace(/```/g, "");
      }
      
      const jsonStart = jsonText.indexOf('{');
      const jsonEnd = jsonText.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        jsonText = jsonText.substring(jsonStart, jsonEnd + 1);
      }

      return JSON.parse(jsonText) as ClassificationResult;
  } catch (e) {
    console.error("AI Processing Failed", e);
    return {
      type: NoteType.MEMO,
      content: text || "Note created (AI Analysis Unavailable)",
    };
  }
};

// Edit a specific note
export const editNoteWithAI = async (originalContent: string, instruction: string): Promise<string> => {
  try {
      const ai = getAiClient();
      const modelId = "gemini-3-flash-preview";
      
      const response = await ai.models.generateContent({
        model: modelId,
        contents: `Original Note: "${originalContent}"\n\nUser Instruction: "${instruction}"\n\nRewrite the note based on the instruction. Return only the new note text.`,
      });

      return response.text || originalContent;
  } catch (e) {
      console.error("AI Edit Failed", e);
      return originalContent;
  }
};