import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

export const createPaymentIntent = async (amount: number) => {
  try {
    const functions = getFunctions(app);
    const createPaymentIntentFunction = httpsCallable(functions, 'createPaymentIntent');
    
    const result: any = await createPaymentIntentFunction({ amount });
    return result.data.clientSecret;
  } catch (error) {
    console.warn("Backend payment init failed. Falling back to DEMO MODE for GitHub Pages.", error);
    
    // Simulate a network delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Throw a specific error that the PremiumModal can catch to enable 'Demo Mode'
    throw new Error("DEMO_MODE");
  }
};