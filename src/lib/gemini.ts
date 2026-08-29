import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;

export const ai = apiKey 
  ? new GoogleGenAI({ apiKey }) 
  : null;

export const model = 'gemini-1.5-flash';
